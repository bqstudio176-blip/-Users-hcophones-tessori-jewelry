-- =============================================================================
-- Content OS — Phase 4 — Migration 1200: Video Studio schema
--
-- Media library (user-owned assets), video projects built from Script Lab
-- scripts, versioned timelines, voiceover takes, renders, and one
-- Postgres-backed job queue (video_jobs) for asset processing, voiceover
-- transcription and rendering, claimed with FOR UPDATE SKIP LOCKED like the
-- Phase 2 analysis queue.
-- =============================================================================

create type public.media_asset_kind as enum ('video', 'image', 'audio');
create type public.video_job_kind as enum ('asset', 'voiceover', 'render');

-- ---------------------------------------------------------------------------
-- Plan limits for Video Studio (decision D3 + draft-render rate limit, D2)
-- ---------------------------------------------------------------------------
create table public.media_storage_limits (
  plan_id                text primary key references public.plans (id) on delete cascade,
  max_bytes              bigint not null check (max_bytes > 0),
  draft_renders_per_hour integer not null check (draft_renders_per_hour >= 0)
);
insert into public.media_storage_limits (plan_id, max_bytes, draft_renders_per_hour) values
  ('free',    2::bigint   * 1024 * 1024 * 1024, 10),
  ('creator', 25::bigint  * 1024 * 1024 * 1024, 10),
  ('studio',  150::bigint * 1024 * 1024 * 1024, 10)
on conflict (plan_id) do nothing;

-- Single source of truth for per-asset limits (D3) and render limits (D4).
create or replace function public.video_limits()
returns jsonb language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'max_asset_bytes', 1073741824,      -- 1 GB
    'max_asset_seconds', 600,           -- 10 min
    'max_output_seconds', 180           -- 3 min
  )
$$;

-- Credits for a render (D2): final = 3 up to 60 s, +1 per started extra 30 s; drafts are free.
create or replace function public.render_credit_cost(p_kind text, p_duration_seconds numeric)
returns integer language sql immutable set search_path = '' as $$
  select case when p_kind = 'final'
    then 3 + greatest(0, ceil((greatest(p_duration_seconds, 0) - 60) / 30.0))::integer
    else 0 end
$$;

-- ---------------------------------------------------------------------------
-- Media assets
-- ---------------------------------------------------------------------------
create table public.media_assets (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  kind                public.media_asset_kind not null,
  origin              text not null default 'upload' check (origin in ('upload', 'recording')),
  title               text not null check (char_length(btrim(title)) between 1 and 200),
  storage_path        text not null unique,
  mime                text not null,
  size_bytes          bigint not null check (size_bytes > 0),
  sha256              text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  status              text not null default 'pending_upload'
                        check (status in ('pending_upload', 'processing', 'ready', 'failed')),
  error               text check (error is null or char_length(error) <= 1000),
  metadata            jsonb not null default '{}'::jsonb,    -- ffprobe facts
  duration_seconds    numeric(9,3),
  width               integer,
  height              integer,
  has_audio           boolean,
  thumbnail_path      text,
  proxy_path          text,
  tags                text[] not null default '{}' check (cardinality(tags) <= 12),
  rights_confirmed_by uuid references public.profiles (id) on delete set null,
  rights_confirmed_at timestamptz not null,
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index media_assets_ws_idx on public.media_assets (workspace_id, created_at desc);
create trigger media_assets_set_updated_at before update on public.media_assets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Video projects (timeline is stored on the project; history in versions)
-- ---------------------------------------------------------------------------
create table public.video_projects (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  script_id         uuid references public.scripts (id) on delete set null,
  script_version    integer,
  script_snapshot   jsonb not null default '{}'::jsonb,   -- {title, target_duration_seconds, scenes[]}
  title             text not null check (char_length(btrim(title)) between 1 and 200),
  format            text not null default 'vertical' check (format in ('vertical', 'square', 'portrait')),
  fps               integer not null default 30 check (fps = 30),
  status            text not null default 'draft' check (status in ('draft', 'ready', 'archived')),
  timeline          jsonb not null check (jsonb_typeof(timeline) = 'object'),
  timeline_version  integer not null default 1 check (timeline_version >= 1),
  ready_render_id   uuid,
  ready_at          timestamptz,
  ready_by          uuid references public.profiles (id) on delete set null,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index video_projects_ws_idx on public.video_projects (workspace_id, updated_at desc);
create index video_projects_script_idx on public.video_projects (script_id);
create trigger video_projects_set_updated_at before update on public.video_projects
  for each row execute function public.set_updated_at();

-- Which assets a project's current timeline uses (maintained by save RPCs).
-- Prevents deleting media that a timeline still needs.
create table public.video_project_assets (
  project_id   uuid not null references public.video_projects (id) on delete cascade,
  asset_id     uuid not null references public.media_assets (id) on delete restrict,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  primary key (project_id, asset_id)
);
create index video_project_assets_asset_idx on public.video_project_assets (asset_id);

create table public.video_timeline_versions (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id   uuid not null references public.video_projects (id) on delete cascade,
  version      integer not null check (version >= 1),
  source       text not null check (source in ('created', 'manual', 'render', 'before_restore', 'restored', 'script_update')),
  timeline     jsonb not null,
  note         text check (note is null or char_length(note) <= 500),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index video_timeline_versions_project_idx on public.video_timeline_versions (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Voiceover takes (recorded or uploaded; transcribed with word timestamps)
-- ---------------------------------------------------------------------------
create table public.voiceover_takes (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id   uuid not null references public.video_projects (id) on delete cascade,
  asset_id     uuid not null references public.media_assets (id) on delete restrict,
  scene_key    text check (scene_key is null or scene_key ~ '^[a-z0-9_-]{1,40}$'),   -- null = whole script
  status       text not null default 'pending'
                 check (status in ('pending', 'transcribing', 'completed', 'unavailable', 'failed')),
  transcript   jsonb,     -- {provider, model, language, text, words:[{start,end,text}]}
  deviation    jsonb,     -- {similarity, missing[], extra[]} vs script text
  error        text check (error is null or char_length(error) <= 1000),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index voiceover_takes_project_idx on public.voiceover_takes (project_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Renders
-- ---------------------------------------------------------------------------
create table public.video_renders (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  project_id        uuid not null references public.video_projects (id) on delete cascade,
  kind              text not null check (kind in ('draft', 'final')),
  status            text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'canceled')),
  timeline_version  integer not null,
  timeline          jsonb not null,           -- exact snapshot rendered
  duration_seconds  numeric(9,3) not null check (duration_seconds > 0),
  settings          jsonb not null default '{}'::jsonb,
  output_path       text,
  srt_path          text,
  stats             jsonb,                    -- measured with ffprobe/ebur128 on the output
  checks            jsonb,                    -- deterministic pre-publish checks
  error             text check (error is null or char_length(error) <= 2000),
  credits_charged   integer not null default 0 check (credits_charged >= 0),
  credits_refunded  boolean not null default false,
  requested_by      uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index video_renders_project_idx on public.video_renders (project_id, created_at desc);
create index video_renders_ws_idx on public.video_renders (workspace_id, created_at desc);
create unique index video_renders_one_active_idx on public.video_renders (project_id) where status in ('queued', 'processing');

alter table public.video_projects
  add constraint video_projects_ready_render_fk foreign key (ready_render_id) references public.video_renders (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Job queue (asset processing, voiceover transcription, rendering)
-- ---------------------------------------------------------------------------
create table public.video_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  kind             public.video_job_kind not null,
  asset_id         uuid references public.media_assets (id) on delete cascade,
  voiceover_id     uuid references public.voiceover_takes (id) on delete cascade,
  render_id        uuid references public.video_renders (id) on delete cascade,
  status           public.analysis_job_status not null default 'queued',
  current_step     text,
  steps            jsonb not null default '[]'::jsonb,
  attempts         integer not null default 0 check (attempts >= 0),
  max_attempts     integer not null default 3 check (max_attempts between 1 and 10),
  run_after        timestamptz not null default now(),
  locked_by        text,
  locked_at        timestamptz,
  heartbeat_at     timestamptz,
  cancel_requested boolean not null default false,
  last_error       text check (last_error is null or char_length(last_error) <= 2000),
  idempotency_key  text check (idempotency_key is null or char_length(idempotency_key) <= 128),
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  constraint video_jobs_target check (
    (kind = 'asset' and asset_id is not null and voiceover_id is null and render_id is null) or
    (kind = 'voiceover' and voiceover_id is not null and asset_id is null and render_id is null) or
    (kind = 'render' and render_id is not null and asset_id is null and voiceover_id is null))
);
create index video_jobs_claim_idx on public.video_jobs (status, run_after) where status in ('queued', 'running');
create unique index video_jobs_idempotency_idx on public.video_jobs (workspace_id, idempotency_key) where idempotency_key is not null;
create index video_jobs_render_idx on public.video_jobs (render_id);
create index video_jobs_asset_idx on public.video_jobs (asset_id);
create index video_jobs_voiceover_idx on public.video_jobs (voiceover_id);

-- ---------------------------------------------------------------------------
-- Scope triggers: every reference must stay inside the row's workspace
-- ---------------------------------------------------------------------------
create or replace function public.video_check_scope()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_table_name = 'video_projects' then
    if new.script_id is not null and not exists (select 1 from public.scripts s where s.id = new.script_id and s.workspace_id = new.workspace_id) then
      raise exception 'script belongs to another workspace' using errcode = '42501';
    end if;
  elsif tg_table_name in ('video_timeline_versions', 'video_renders') then
    if not exists (select 1 from public.video_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id) then
      raise exception 'project belongs to another workspace' using errcode = '42501';
    end if;
  elsif tg_table_name = 'voiceover_takes' then
    if not exists (select 1 from public.video_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id)
       or not exists (select 1 from public.media_assets a where a.id = new.asset_id and a.workspace_id = new.workspace_id) then
      raise exception 'project or asset belongs to another workspace' using errcode = '42501';
    end if;
  elsif tg_table_name = 'video_project_assets' then
    if not exists (select 1 from public.video_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id)
       or not exists (select 1 from public.media_assets a where a.id = new.asset_id and a.workspace_id = new.workspace_id) then
      raise exception 'project or asset belongs to another workspace' using errcode = '42501';
    end if;
  end if;
  return new;
end; $$;

create trigger video_projects_check_scope before insert or update on public.video_projects
  for each row execute function public.video_check_scope();
create trigger video_timeline_versions_check_scope before insert on public.video_timeline_versions
  for each row execute function public.video_check_scope();
create trigger video_renders_check_scope before insert or update on public.video_renders
  for each row execute function public.video_check_scope();
create trigger voiceover_takes_check_scope before insert or update on public.voiceover_takes
  for each row execute function public.video_check_scope();
create trigger video_project_assets_check_scope before insert or update on public.video_project_assets
  for each row execute function public.video_check_scope();

-- Append-only history: update/delete are revoked in migration 1300, even for service_role.
