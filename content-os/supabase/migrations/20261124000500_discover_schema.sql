-- =============================================================================
-- Content OS — Phase 2 — Migration 0500: Discover (references, tags, searches)
-- Reuses Phase 1 helpers (is_workspace_member, has_workspace_role,
-- log_audit_event). Every row is workspace-scoped and RLS-protected.
-- =============================================================================

create type public.reference_source as enum ('upload', 'instagram', 'youtube', 'web');
create type public.reference_media_status as enum ('none', 'pending_upload', 'uploaded', 'rejected');
create type public.reference_analysis_status as enum ('not_analyzed', 'queued', 'processing', 'analyzed', 'failed');

-- ---------------------------------------------------------------------------
-- discovery_sources: catalogue of discovery providers (platform-managed).
-- Capabilities live in code (src/server/discovery/providers); this table lets
-- operators disable a provider and gives history rows a stable FK.
-- ---------------------------------------------------------------------------
create table public.discovery_sources (
  id          text primary key check (id ~ '^[a-z0-9_]{2,40}$'),
  name        text not null,
  description text,
  is_enabled  boolean not null default true,
  docs_url    text,
  created_at  timestamptz not null default now()
);

insert into public.discovery_sources (id, name, description, docs_url) values
  ('library', 'Reference library', 'Searches references already saved in this workspace.', null),
  ('youtube', 'YouTube Data API v3', 'Keyword search and most-popular charts for public YouTube videos (API key required).', 'https://developers.google.com/youtube/v3/docs/search/list'),
  ('instagram_own_media', 'Instagram — connected account media', 'Media published by the Instagram account connected to the workspace.', 'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login'),
  ('instagram_hashtag', 'Instagram — hashtag search', 'Public hashtag search. Requires Facebook Login for Business and Meta app review; not available in this deployment.', 'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search')
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- content_references: the reference library
-- ---------------------------------------------------------------------------
create table public.content_references (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  source_type       public.reference_source not null,
  provider          text not null default 'manual' references public.discovery_sources (id) on update cascade
                      deferrable initially immediate,
  external_id       text check (external_id is null or char_length(external_id) <= 200),
  url               text check (url is null or (char_length(url) <= 2048 and url ~ '^https://')),
  normalized_url    text check (normalized_url is null or char_length(normalized_url) <= 2048),
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  description       text check (description is null or char_length(description) <= 5000),
  author_name       text check (author_name is null or char_length(author_name) <= 200),
  thumbnail_url     text check (thumbnail_url is null or (char_length(thumbnail_url) <= 2048 and thumbnail_url ~ '^https://')),
  duration_seconds  numeric(10,3) check (duration_seconds is null or duration_seconds >= 0),
  category          text check (category is null or char_length(category) <= 60),
  notes             text check (notes is null or char_length(notes) <= 10000),
  -- Media (server-managed; clients cannot write these columns)
  media_status      public.reference_media_status not null default 'none',
  media_path        text unique,
  media_mime        text,
  media_size_bytes  bigint check (media_size_bytes is null or media_size_bytes >= 0),
  media_sha256      text check (media_sha256 is null or media_sha256 ~ '^[0-9a-f]{64}$'),
  -- URL accessibility check result (server-managed)
  url_check         jsonb not null default '{}'::jsonb,
  analysis_status   public.reference_analysis_status not null default 'not_analyzed',
  metrics           jsonb not null default '{}'::jsonb,   -- provider-reported metrics only
  retrieved_at      timestamptz,                         -- when external metadata was fetched
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- 'manual' is a pseudo-provider for user-entered references.
insert into public.discovery_sources (id, name, description) values
  ('manual', 'Manual import', 'URL pasted or file uploaded by a user.')
on conflict (id) do nothing;

create index content_references_ws_created_idx on public.content_references (workspace_id, created_at desc);
create index content_references_ws_status_idx on public.content_references (workspace_id, analysis_status);
create index content_references_ws_category_idx on public.content_references (workspace_id, category);
-- Duplicate detection (per workspace): same URL, same file, same provider item.
create unique index content_references_ws_url_uniq
  on public.content_references (workspace_id, normalized_url) where normalized_url is not null;
create unique index content_references_ws_sha_uniq
  on public.content_references (workspace_id, media_sha256) where media_sha256 is not null;
create unique index content_references_ws_external_uniq
  on public.content_references (workspace_id, provider, external_id) where external_id is not null;
create trigger content_references_set_updated_at before update on public.content_references
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- reference_tags
-- ---------------------------------------------------------------------------
create table public.reference_tags (
  reference_id uuid not null references public.content_references (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  tag          text not null check (tag ~ '^[a-z0-9][a-z0-9 _-]{0,39}$'),
  created_at   timestamptz not null default now(),
  primary key (reference_id, tag)
);
create index reference_tags_ws_tag_idx on public.reference_tags (workspace_id, tag);

-- Tag rows must belong to the same workspace as their reference.
create or replace function public.reference_tags_check_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.content_references r
    where r.id = new.reference_id and r.workspace_id = new.workspace_id
  ) then
    raise exception 'tag workspace does not match reference workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger reference_tags_check_workspace before insert or update on public.reference_tags
  for each row execute function public.reference_tags_check_workspace();

-- ---------------------------------------------------------------------------
-- discovery_searches (research history + saved searches) and results
-- ---------------------------------------------------------------------------
create table public.discovery_searches (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  query        text not null default '' check (char_length(query) <= 300),
  filters      jsonb not null default '{}'::jsonb check (jsonb_typeof(filters) = 'object'),
  providers    text[] not null default '{}',
  name         text check (name is null or char_length(btrim(name)) between 1 and 80),
  is_saved     boolean not null default false,
  result_count integer not null default 0 check (result_count >= 0),
  status       text not null default 'completed' check (status in ('completed', 'partial', 'failed')),
  errors       jsonb not null default '[]'::jsonb,
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index discovery_searches_ws_created_idx on public.discovery_searches (workspace_id, created_at desc);
create index discovery_searches_ws_saved_idx on public.discovery_searches (workspace_id) where is_saved;

create table public.discovery_results (
  id               uuid primary key default gen_random_uuid(),
  search_id        uuid not null references public.discovery_searches (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  provider         text not null references public.discovery_sources (id),
  external_id      text not null check (char_length(external_id) <= 200),
  url              text check (url is null or url ~ '^https://'),
  title            text not null check (char_length(title) <= 500),
  description      text check (description is null or char_length(description) <= 5000),
  author_name      text,
  thumbnail_url    text check (thumbnail_url is null or thumbnail_url ~ '^https://'),
  published_at     timestamptz,
  duration_seconds numeric(10,3),
  metrics          jsonb not null default '{}'::jsonb,
  retrieved_at     timestamptz not null default now(),
  reference_id     uuid references public.content_references (id) on delete set null,
  position         integer not null default 0,
  unique (search_id, provider, external_id)
);
create index discovery_results_search_idx on public.discovery_results (search_id, position);

-- Results must share the workspace of their search.
create or replace function public.discovery_results_check_workspace()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.discovery_searches s
    where s.id = new.search_id and s.workspace_id = new.workspace_id
  ) then
    raise exception 'result workspace does not match search workspace' using errcode = '23514';
  end if;
  if new.reference_id is not null and not exists (
    select 1 from public.content_references r
    where r.id = new.reference_id and r.workspace_id = new.workspace_id
  ) then
    raise exception 'linked reference belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger discovery_results_check_workspace before insert or update on public.discovery_results
  for each row execute function public.discovery_results_check_workspace();
