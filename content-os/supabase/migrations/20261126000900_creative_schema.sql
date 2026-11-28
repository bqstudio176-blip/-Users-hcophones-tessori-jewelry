-- =============================================================================
-- Content OS — Phase 3 — Migration 0900: Script Lab & Creative Intelligence
--
-- Reuses: workspaces/RLS helpers (0200), credit ledger apply_credit_transaction
-- (0200), audit log, content_references / video_analyses (0500/0600).
-- ai_invocations (0600) is extended with agent_run_id and serves as the
-- per-model-call usage record ("ai_usage_records"); no duplicate table.
-- =============================================================================

create type public.creative_rule_category as enum (
  'attention_psychology', 'hooks_openings', 'storytelling', 'audience_retention', 'curiosity',
  'emotional_connection', 'authority_credibility', 'persuasion', 'conversion', 'calls_to_action'
);
create type public.creative_rule_status as enum ('draft', 'pending_approval', 'approved', 'disabled');
create type public.creative_evidence_type as enum ('established_principle', 'practitioner_heuristic', 'experimental');
create type public.creative_complexity as enum ('basic', 'intermediate', 'advanced');
create type public.creative_agent as enum ('research', 'strategy', 'hook', 'script', 'script_edit', 'quality');
create type public.hook_category as enum (
  'curiosity', 'contrarian', 'unexpected_information', 'problem_identification', 'direct_question',
  'story_opening', 'educational', 'authority', 'emotional_connection', 'demonstration'
);
create type public.script_format as enum (
  'instagram_reel', 'educational', 'promotional', 'storytelling', 'talking_head',
  'product_presentation', 'list_based', 'tutorial', 'opinion', 'narrative'
);

-- ---------------------------------------------------------------------------
-- Platform-managed configuration: credits per agent and usage limits per plan
-- ---------------------------------------------------------------------------
create table public.ai_agent_pricing (
  agent       public.creative_agent primary key,
  credits     integer not null check (credits >= 0),
  description text
);
insert into public.ai_agent_pricing (agent, credits, description) values
  ('research', 1, 'Research brief from selected references'),
  ('strategy', 2, 'Strategy recommendations'),
  ('hook', 2, 'Batch of hook variations'),
  ('script', 4, 'Complete script with scenes'),
  ('script_edit', 1, 'Section regeneration / rewrite / tone / shorten / expand proposal'),
  ('quality', 1, 'Quality assessment');

create table public.ai_usage_limits (
  plan_id               text primary key references public.plans (id) on delete cascade,
  max_runs_per_hour     integer not null check (max_runs_per_hour > 0),
  max_runs_per_day      integer not null check (max_runs_per_day > 0),
  max_runs_per_user_min integer not null check (max_runs_per_user_min > 0)
);
insert into public.ai_usage_limits (plan_id, max_runs_per_hour, max_runs_per_day, max_runs_per_user_min) values
  ('free', 20, 60, 5), ('creator', 60, 300, 8), ('studio', 150, 1000, 12);

-- ---------------------------------------------------------------------------
-- Projects and strategies
-- ---------------------------------------------------------------------------
create table public.creative_projects (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name         text not null check (char_length(btrim(name)) between 1 and 120),
  description  text check (description is null or char_length(description) <= 2000),
  status       text not null default 'active' check (status in ('active', 'archived')),
  created_by   uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index creative_projects_ws_idx on public.creative_projects (workspace_id, updated_at desc);
create trigger creative_projects_set_updated_at before update on public.creative_projects
  for each row execute function public.set_updated_at();

create table public.content_strategies (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  project_id          uuid not null references public.creative_projects (id) on delete cascade,
  name                text not null check (char_length(btrim(name)) between 1 and 120),
  niche               text check (niche is null or char_length(niche) <= 120),
  target_audience     text check (target_audience is null or char_length(target_audience) <= 1000),
  objective           text not null default 'educate'
                        check (objective in ('awareness', 'educate', 'engage', 'trust', 'convert', 'community', 'entertain')),
  main_topic          text check (main_topic is null or char_length(main_topic) <= 300),
  tone                text check (tone is null or char_length(tone) <= 80),
  platform            text not null default 'instagram' check (platform in ('instagram', 'tiktok', 'youtube_shorts', 'youtube', 'linkedin', 'other')),
  preferred_format    public.script_format not null default 'instagram_reel',
  duration_seconds    integer not null default 45 check (duration_seconds between 5 and 1800),
  reference_ids       uuid[] not null default '{}',
  manual_topics       text[] not null default '{}',
  restrictions        text check (restrictions is null or char_length(restrictions) <= 2000),
  desired_cta         text check (desired_cta is null or char_length(desired_cta) <= 300),
  use_content_history boolean not null default true,
  research_brief      jsonb,     -- validated Research Agent output (with provenance)
  recommendations     jsonb,     -- validated Strategy Agent output summary
  selected_rule_ids   uuid[] not null default '{}',
  created_by          uuid references public.profiles (id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (cardinality(reference_ids) <= 10),
  check (cardinality(manual_topics) <= 10)
);
create index content_strategies_project_idx on public.content_strategies (project_id, updated_at desc);
create trigger content_strategies_set_updated_at before update on public.content_strategies
  for each row execute function public.set_updated_at();

-- Strategy must belong to the project's workspace; referenced content too.
create or replace function public.content_strategies_check_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.creative_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id) then
    raise exception 'project belongs to another workspace' using errcode = '23514';
  end if;
  if cardinality(new.reference_ids) > 0 and exists (
    select 1 from unnest(new.reference_ids) rid
    where not exists (select 1 from public.content_references r where r.id = rid and r.workspace_id = new.workspace_id)
  ) then
    raise exception 'a referenced item belongs to another workspace or does not exist' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger content_strategies_check_scope before insert or update on public.content_strategies
  for each row execute function public.content_strategies_check_scope();

-- ---------------------------------------------------------------------------
-- Creative rules (global library: workspace_id IS NULL; workspace rules otherwise)
-- ---------------------------------------------------------------------------
create table public.creative_rules (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid references public.workspaces (id) on delete cascade,
  slug                   text not null check (slug ~ '^[a-z0-9][a-z0-9-]{2,80}$'),
  name                   text not null check (char_length(btrim(name)) between 3 and 120),
  category               public.creative_rule_category not null,
  description            text not null check (char_length(description) between 10 and 2000),
  objective              text not null check (char_length(objective) between 5 and 600),
  application_conditions text[] not null check (cardinality(application_conditions) between 1 and 10),
  avoidance_conditions   text[] not null default '{}' check (cardinality(avoidance_conditions) <= 10),
  example                text not null check (char_length(example) between 5 and 1500),
  recommended_formats    public.script_format[] not null default '{}',
  objectives             text[] not null default '{}',  -- content objectives this rule serves (empty = any)
  tones_excluded         text[] not null default '{}',  -- tones where the rule does not fit
  min_duration_seconds   integer check (min_duration_seconds is null or min_duration_seconds >= 0),
  max_duration_seconds   integer check (max_duration_seconds is null or max_duration_seconds > 0),
  complexity_level       public.creative_complexity not null default 'basic',
  evidence_type          public.creative_evidence_type not null,
  evidence_note          text check (evidence_note is null or char_length(evidence_note) <= 600),
  version                integer not null default 1 check (version >= 1),
  status                 public.creative_rule_status not null default 'draft',
  approved_by            uuid references public.profiles (id) on delete set null,
  approved_at            timestamptz,
  created_by             uuid references public.profiles (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create unique index creative_rules_global_slug_idx on public.creative_rules (slug) where workspace_id is null;
create unique index creative_rules_ws_slug_idx on public.creative_rules (workspace_id, slug) where workspace_id is not null;
create index creative_rules_category_idx on public.creative_rules (category, status);
create trigger creative_rules_set_updated_at before update on public.creative_rules
  for each row execute function public.set_updated_at();

create table public.creative_rule_tags (
  rule_id uuid not null references public.creative_rules (id) on delete cascade,
  tag     text not null check (tag ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  primary key (rule_id, tag)
);
create index creative_rule_tags_tag_idx on public.creative_rule_tags (tag);

-- Append-only history: every content change snapshots the PREVIOUS version.
create table public.creative_rule_versions (
  id          bigint generated always as identity primary key,
  rule_id     uuid not null references public.creative_rules (id) on delete cascade,
  version     integer not null,
  snapshot    jsonb not null,
  changed_by  uuid references public.profiles (id) on delete set null,
  change_note text,
  created_at  timestamptz not null default now(),
  unique (rule_id, version)
);

create or replace function public.creative_rules_versioning()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (new.name, new.category, new.description, new.objective, new.application_conditions, new.avoidance_conditions,
      new.example, new.recommended_formats, new.objectives, new.tones_excluded, new.min_duration_seconds,
      new.max_duration_seconds, new.complexity_level, new.evidence_type, new.evidence_note)
     is distinct from
     (old.name, old.category, old.description, old.objective, old.application_conditions, old.avoidance_conditions,
      old.example, old.recommended_formats, old.objectives, old.tones_excluded, old.min_duration_seconds,
      old.max_duration_seconds, old.complexity_level, old.evidence_type, old.evidence_note) then
    insert into public.creative_rule_versions (rule_id, version, snapshot, changed_by)
    values (old.id, old.version, to_jsonb(old) - 'updated_at', auth.uid())
    on conflict (rule_id, version) do nothing;
    new.version := old.version + 1;
    -- Edited content must be re-approved (workspace rules).
    if old.workspace_id is not null and old.status = 'approved' then
      new.status := 'pending_approval';
      new.approved_by := null;
      new.approved_at := null;
    end if;
  end if;
  return new;
end; $$;
create trigger creative_rules_versioning before update on public.creative_rules
  for each row execute function public.creative_rules_versioning();

-- Workspace-level enable/disable of global rules.
create table public.creative_rule_overrides (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  rule_id      uuid not null references public.creative_rules (id) on delete cascade,
  enabled      boolean not null,
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, rule_id)
);

-- ---------------------------------------------------------------------------
-- AI agent runs (one per orchestrated agent invocation)
-- ---------------------------------------------------------------------------
create table public.ai_agent_runs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  project_id      uuid references public.creative_projects (id) on delete set null,
  agent           public.creative_agent not null,
  status          text not null check (status in ('succeeded', 'failed', 'invalid_output', 'refused', 'rejected')),
  provider        text,
  model           text,
  prompt_version  text,
  input_tokens    integer check (input_tokens is null or input_tokens >= 0),
  output_tokens   integer check (output_tokens is null or output_tokens >= 0),
  duration_ms     integer check (duration_ms is null or duration_ms >= 0),
  cost_usd        numeric(12,6),
  credits_charged integer not null default 0 check (credits_charged >= 0),
  error           text check (error is null or char_length(error) <= 1000),
  request_summary jsonb not null default '{}'::jsonb,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now()
);
create index ai_agent_runs_ws_created_idx on public.ai_agent_runs (workspace_id, created_at desc);
create index ai_agent_runs_user_created_idx on public.ai_agent_runs (created_by, created_at desc);

alter table public.ai_invocations add column agent_run_id uuid references public.ai_agent_runs (id) on delete cascade;
create index ai_invocations_agent_run_idx on public.ai_invocations (agent_run_id);

-- ---------------------------------------------------------------------------
-- Generated ideas (Strategy Agent recommendations) and hooks
-- ---------------------------------------------------------------------------
create table public.generated_ideas (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id   uuid not null references public.creative_projects (id) on delete cascade,
  strategy_id  uuid references public.content_strategies (id) on delete cascade,
  agent_run_id uuid references public.ai_agent_runs (id) on delete set null,
  kind         text not null check (kind in ('opportunity', 'topic', 'angle', 'audience_hypothesis', 'objective', 'format', 'approach', 'hook_idea', 'cta')),
  title        text not null check (char_length(title) between 1 and 300),
  body         text check (body is null or char_length(body) <= 3000),
  reasoning    text not null check (char_length(reasoning) between 1 and 3000),
  provenance   jsonb not null default '[]'::jsonb check (jsonb_typeof(provenance) = 'array'),
  is_favorite  boolean not null default false,
  created_at   timestamptz not null default now()
);
create index generated_ideas_strategy_idx on public.generated_ideas (strategy_id, kind);

create table public.generated_hooks (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces (id) on delete cascade,
  project_id                 uuid not null references public.creative_projects (id) on delete cascade,
  strategy_id                uuid references public.content_strategies (id) on delete set null,
  agent_run_id               uuid references public.ai_agent_runs (id) on delete set null,
  text                       text not null check (char_length(btrim(text)) between 3 and 400),
  original_text              text not null,
  category                   public.hook_category not null,
  mechanism                  text not null check (char_length(mechanism) <= 600),
  visual_opening             text not null check (char_length(visual_opening) <= 600),
  delivery                   text not null check (char_length(delivery) <= 400),
  estimated_duration_seconds numeric(6,2) not null check (estimated_duration_seconds > 0 and estimated_duration_seconds <= 30),
  rationale                  text not null check (char_length(rationale) <= 1500),
  rule_ids                   uuid[] not null default '{}',
  is_favorite                boolean not null default false,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);
create index generated_hooks_project_idx on public.generated_hooks (project_id, created_at desc);
create trigger generated_hooks_set_updated_at before update on public.generated_hooks
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Scripts, scenes, versions, proposals, quality reports
-- ---------------------------------------------------------------------------
create table public.scripts (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces (id) on delete cascade,
  project_id              uuid not null references public.creative_projects (id) on delete cascade,
  strategy_id             uuid references public.content_strategies (id) on delete set null,
  hook_id                 uuid references public.generated_hooks (id) on delete set null,
  parent_script_id        uuid references public.scripts (id) on delete set null,   -- alternatives
  title                   text not null check (char_length(btrim(title)) between 1 and 200),
  format                  public.script_format not null,
  target_duration_seconds integer not null check (target_duration_seconds between 5 and 1800),
  tone                    text check (tone is null or char_length(tone) <= 80),
  status                  text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  sections                jsonb not null default '{}'::jsonb check (jsonb_typeof(sections) = 'object'),
  rule_ids                uuid[] not null default '{}',
  notes                   text check (notes is null or char_length(notes) <= 10000),
  current_version         integer not null default 0,
  pending_proposal        jsonb,       -- AI edit awaiting explicit user confirmation
  created_by              uuid references public.profiles (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index scripts_project_idx on public.scripts (project_id, updated_at desc);
create trigger scripts_set_updated_at before update on public.scripts
  for each row execute function public.set_updated_at();

create table public.script_scenes (
  id                         uuid primary key default gen_random_uuid(),
  workspace_id               uuid not null references public.workspaces (id) on delete cascade,
  script_id                  uuid not null references public.scripts (id) on delete cascade,
  position                   integer not null check (position >= 1),
  section                    text not null default 'main_development'
                               check (section in ('hook', 'opening', 'context', 'main_development', 'supporting_arguments', 'transition', 'conclusion', 'cta')),
  scene_title                text not null check (char_length(btrim(scene_title)) between 1 and 200),
  estimated_duration_seconds numeric(7,2) not null check (estimated_duration_seconds > 0 and estimated_duration_seconds <= 600),
  spoken_text                text not null default '' check (char_length(spoken_text) <= 5000),
  visual_direction           text not null default '' check (char_length(visual_direction) <= 2000),
  camera_direction           text not null default '' check (char_length(camera_direction) <= 1000),
  on_screen_text             text not null default '' check (char_length(on_screen_text) <= 500),
  audio_direction            text not null default '' check (char_length(audio_direction) <= 1000),
  transition                 text not null default '' check (char_length(transition) <= 300),
  creative_purpose           text not null default '' check (char_length(creative_purpose) <= 600),
  is_locked                  boolean not null default false,   -- user-approved: AI may not overwrite
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now(),
  constraint script_scenes_position_uniq unique (script_id, position) deferrable initially deferred
);
create trigger script_scenes_set_updated_at before update on public.script_scenes
  for each row execute function public.set_updated_at();

create table public.script_versions (
  id          uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  script_id   uuid not null references public.scripts (id) on delete cascade,
  version     integer not null check (version >= 1),
  source      text not null check (source in ('generated', 'manual_save', 'before_ai_edit', 'ai_edit_applied', 'before_restore', 'restored')),
  snapshot    jsonb not null,   -- {title, sections, scenes[], tone, target_duration_seconds}
  note        text check (note is null or char_length(note) <= 500),
  created_by  uuid references public.profiles (id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (script_id, version)
);

create table public.script_quality_reports (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  script_id      uuid not null references public.scripts (id) on delete cascade,
  script_version integer not null,
  agent_run_id   uuid references public.ai_agent_runs (id) on delete set null,
  report         jsonb not null check (jsonb_typeof(report) = 'object'),
  checks         jsonb not null default '{}'::jsonb,   -- deterministic checks (duration, sections, originality)
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index script_quality_reports_script_idx on public.script_quality_reports (script_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Feedback and preferences
-- ---------------------------------------------------------------------------
create table public.script_feedback (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  target_type    text not null check (target_type in ('idea', 'hook', 'script', 'recommendation', 'quality_report', 'strategy')),
  target_id      uuid not null,
  target_version integer,
  rating         text not null check (rating in ('useful', 'not_useful')),
  reasons        text[] not null default '{}'
                   check (reasons <@ array['useful', 'not_relevant', 'too_generic', 'too_long', 'too_commercial', 'wrong_tone', 'needs_more_storytelling', 'other']::text[]),
  comment        text check (comment is null or char_length(comment) <= 1000),
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now()
);
create index script_feedback_ws_idx on public.script_feedback (workspace_id, created_at desc);
create index script_feedback_target_idx on public.script_feedback (target_type, target_id);

create table public.creative_preferences (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind         text not null check (kind in ('prefer', 'avoid')),
  scope        text not null check (scope in ('tone', 'length', 'style', 'topic', 'format', 'cta', 'storytelling', 'other')),
  statement    text not null check (char_length(btrim(statement)) between 3 and 300),
  source       text not null default 'user' check (source in ('user', 'feedback_suggestion')),
  approved     boolean not null default false,
  created_by   uuid references public.profiles (id) on delete set null,
  approved_by  uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);
create index creative_preferences_ws_idx on public.creative_preferences (workspace_id) where approved;

-- Output rows must stay inside the workspace of the project they belong to.
create or replace function public.creative_outputs_check_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.creative_projects p where p.id = new.project_id and p.workspace_id = new.workspace_id) then
    raise exception 'project belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger generated_ideas_check_scope before insert or update on public.generated_ideas
  for each row execute function public.creative_outputs_check_scope();
create trigger generated_hooks_check_scope before insert or update on public.generated_hooks
  for each row execute function public.creative_outputs_check_scope();
create trigger scripts_check_scope before insert or update on public.scripts
  for each row execute function public.creative_outputs_check_scope();

create or replace function public.script_children_check_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.scripts s where s.id = new.script_id and s.workspace_id = new.workspace_id) then
    raise exception 'script belongs to another workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger script_scenes_check_scope before insert or update on public.script_scenes
  for each row execute function public.script_children_check_scope();
create trigger script_versions_check_scope before insert on public.script_versions
  for each row execute function public.script_children_check_scope();
create trigger script_quality_reports_check_scope before insert on public.script_quality_reports
  for each row execute function public.script_children_check_scope();
