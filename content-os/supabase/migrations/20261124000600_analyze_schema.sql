-- =============================================================================
-- Content OS — Phase 2 — Migration 0600: Analyze (analyses, jobs, transcripts,
-- scenes, reports, AI invocation records) + job queue functions.
--
-- Background processing uses a Postgres-backed queue (analysis_jobs claimed
-- with FOR UPDATE SKIP LOCKED) instead of Redis/BullMQ, which is not part of
-- the approved architecture. See docs/SYSTEM_ARCHITECTURE.md §8.
-- =============================================================================

create type public.analysis_status as enum ('queued', 'processing', 'completed', 'failed', 'canceled');
create type public.analysis_job_status as enum ('queued', 'running', 'succeeded', 'failed', 'canceled');

-- Credits charged per analysis (single source of truth).
create or replace function public.analysis_credit_cost()
returns integer
language sql
immutable
set search_path = ''
as $$ select 5 $$;

-- ---------------------------------------------------------------------------
-- video_analyses: one row per analysis run of a reference
-- ---------------------------------------------------------------------------
create table public.video_analyses (
  id                uuid primary key default gen_random_uuid(),
  workspace_id      uuid not null references public.workspaces (id) on delete cascade,
  reference_id      uuid not null references public.content_references (id) on delete cascade,
  status            public.analysis_status not null default 'queued',
  requested_by      uuid references public.profiles (id) on delete set null,
  media_metadata    jsonb not null default '{}'::jsonb,   -- ffprobe facts
  processing        jsonb not null default '{}'::jsonb,   -- scene threshold, frame count, etc.
  transcript_status text not null default 'pending'
                      check (transcript_status in ('pending', 'completed', 'no_audio', 'unavailable', 'failed')),
  visual_status     text not null default 'pending'
                      check (visual_status in ('pending', 'completed', 'partial', 'unavailable', 'failed')),
  error             text check (error is null or char_length(error) <= 2000),
  credits_charged   integer not null default 0 check (credits_charged >= 0),
  credits_refunded  boolean not null default false,
  created_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index video_analyses_ws_created_idx on public.video_analyses (workspace_id, created_at desc);
create index video_analyses_reference_idx on public.video_analyses (reference_id, created_at desc);
-- At most one active analysis per reference.
create unique index video_analyses_one_active_idx
  on public.video_analyses (reference_id) where status in ('queued', 'processing');

-- ---------------------------------------------------------------------------
-- analysis_jobs: execution state for the background worker
-- ---------------------------------------------------------------------------
create table public.analysis_jobs (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  analysis_id      uuid not null unique references public.video_analyses (id) on delete cascade,
  status           public.analysis_job_status not null default 'queued',
  current_step     text,
  steps            jsonb not null default '[]'::jsonb,   -- [{step,status,started_at,finished_at,detail}]
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
  finished_at      timestamptz
);
create index analysis_jobs_claim_idx on public.analysis_jobs (status, run_after) where status in ('queued', 'running');
create unique index analysis_jobs_idempotency_idx
  on public.analysis_jobs (workspace_id, idempotency_key) where idempotency_key is not null;

create table public.analysis_job_logs (
  id           bigint generated always as identity primary key,
  job_id       uuid not null references public.analysis_jobs (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  level        text not null check (level in ('debug', 'info', 'warn', 'error')),
  step         text,
  message      text not null check (char_length(message) <= 2000),
  data         jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index analysis_job_logs_job_idx on public.analysis_job_logs (job_id, id);

-- ---------------------------------------------------------------------------
-- transcripts + segments
-- ---------------------------------------------------------------------------
create table public.transcripts (
  id               uuid primary key default gen_random_uuid(),
  analysis_id      uuid not null unique references public.video_analyses (id) on delete cascade,
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  provider         text not null,
  model            text,
  language         text,
  full_text        text not null default '',
  duration_seconds numeric(10,3),
  created_at       timestamptz not null default now()
);

create table public.transcript_segments (
  id            uuid primary key default gen_random_uuid(),
  transcript_id uuid not null references public.transcripts (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  idx           integer not null check (idx >= 0),
  start_ms      integer not null check (start_ms >= 0),
  end_ms        integer not null,
  text          text not null,
  speaker       text,
  confidence    numeric(6,5),
  unique (transcript_id, idx),
  check (end_ms >= start_ms)
);

-- ---------------------------------------------------------------------------
-- detected_scenes: boundaries come from ffmpeg scene detection
-- ---------------------------------------------------------------------------
create table public.detected_scenes (
  id                 uuid primary key default gen_random_uuid(),
  analysis_id        uuid not null references public.video_analyses (id) on delete cascade,
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  idx                integer not null check (idx >= 0),
  start_ms           integer not null check (start_ms >= 0),
  end_ms             integer not null,
  duration_ms        integer generated always as (end_ms - start_ms) stored,
  detection_score    numeric(6,5),          -- ffmpeg scene score of the cut that starts this scene
  frame_path         text,                  -- representative frame in storage
  frame_time_ms      integer,
  visual_analyzed    boolean not null default false,
  visual             jsonb not null default '{}'::jsonb,
  transcript_excerpt text,
  purpose            text,
  editing_notes      text,
  unique (analysis_id, idx),
  check (end_ms > start_ms)
);

-- ---------------------------------------------------------------------------
-- analysis_reports: validated AI output + provenance
-- ---------------------------------------------------------------------------
create table public.analysis_reports (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid not null unique references public.video_analyses (id) on delete cascade,
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  schema_version  integer not null default 1,
  sections        jsonb not null check (jsonb_typeof(sections) = 'object'),
  user_notes      text check (user_notes is null or char_length(user_notes) <= 10000),
  model_provider  text not null,
  model_id        text not null,
  prompt_versions jsonb not null default '{}'::jsonb,
  input_tokens    integer,
  output_tokens   integer,
  cost_usd        numeric(12,6),
  processing_ms   integer,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create trigger analysis_reports_set_updated_at before update on public.analysis_reports
  for each row execute function public.set_updated_at();

create table public.ai_invocations (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  analysis_id    uuid references public.video_analyses (id) on delete cascade,
  purpose        text not null,
  provider       text not null,
  model          text not null,
  prompt_version text,
  status         text not null check (status in ('succeeded', 'failed', 'invalid_output', 'refused')),
  input_tokens   integer,
  output_tokens  integer,
  latency_ms     integer,
  cost_usd       numeric(12,6),
  error          text,
  created_at     timestamptz not null default now()
);
create index ai_invocations_analysis_idx on public.ai_invocations (analysis_id);

-- =============================================================================
-- Functions
-- =============================================================================

-- Recompute a reference's analysis_status from its analyses (internal).
create or replace function public.sync_reference_analysis_status(p_reference_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.reference_analysis_status;
begin
  select case
    when exists (select 1 from public.video_analyses where reference_id = p_reference_id and status = 'processing') then 'processing'
    when exists (select 1 from public.video_analyses where reference_id = p_reference_id and status = 'queued') then 'queued'
    when exists (select 1 from public.video_analyses where reference_id = p_reference_id and status = 'completed') then 'analyzed'
    when (select status from public.video_analyses where reference_id = p_reference_id order by created_at desc limit 1) = 'failed' then 'failed'
    else 'not_analyzed'
  end::public.reference_analysis_status into v_status;

  update public.content_references set analysis_status = v_status where id = p_reference_id;
end;
$$;

-- Refund the credits of an analysis exactly once (internal).
create or replace function public.refund_analysis_credits(p_analysis_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.video_analyses;
begin
  select * into v_a from public.video_analyses where id = p_analysis_id for update;
  if not found or v_a.credits_charged = 0 or v_a.credits_refunded then
    return;
  end if;
  perform public.apply_credit_transaction(
    v_a.workspace_id, 'refund', v_a.credits_charged, 'Refund: video analysis not completed',
    'analysis', 'refund:' || v_a.id::text, jsonb_build_object('analysis_id', v_a.id), null
  );
  update public.video_analyses set credits_refunded = true where id = p_analysis_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Upload flow (called by signed-in members)
-- ---------------------------------------------------------------------------
create or replace function public.begin_reference_upload(
  p_reference_id uuid,
  p_mime text,
  p_size_bytes bigint
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.content_references;
  v_ext text;
  v_path text;
begin
  select * into v_ref from public.content_references where id = p_reference_id for update;
  if not found or not public.is_workspace_member(v_ref.workspace_id) then
    raise exception 'reference not found' using errcode = 'P0002';
  end if;
  v_ext := case p_mime
    when 'video/mp4' then 'mp4'
    when 'video/quicktime' then 'mov'
    when 'video/webm' then 'webm'
    else null end;
  if v_ext is null then
    raise exception 'unsupported file type: use MP4, MOV or WebM' using errcode = '22023';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > 209715200 then
    raise exception 'file must be between 1 byte and 200 MB' using errcode = '22023';
  end if;
  if v_ref.media_status = 'uploaded' then
    raise exception 'this reference already has a video' using errcode = '22023';
  end if;
  if v_ref.analysis_status in ('queued', 'processing') then
    raise exception 'an analysis is in progress' using errcode = '22023';
  end if;

  v_path := v_ref.workspace_id::text || '/references/' || v_ref.id::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  update public.content_references
  set media_status = 'pending_upload', media_path = v_path, media_mime = p_mime,
      media_size_bytes = p_size_bytes, media_sha256 = null
  where id = p_reference_id;
  return v_path;
end;
$$;

create or replace function public.complete_reference_upload(p_reference_id uuid, p_sha256 text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ref public.content_references;
  v_size bigint;
begin
  select * into v_ref from public.content_references where id = p_reference_id for update;
  if not found or not public.is_workspace_member(v_ref.workspace_id) then
    raise exception 'reference not found' using errcode = 'P0002';
  end if;
  if v_ref.media_status <> 'pending_upload' or v_ref.media_path is null then
    raise exception 'no upload in progress' using errcode = '22023';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
  from storage.objects o where o.bucket_id = 'media' and o.name = v_ref.media_path;
  if not found then
    raise exception 'uploaded file not found' using errcode = '22023';
  end if;
  if v_size is null or v_size > 209715200 then
    raise exception 'uploaded file exceeds 200 MB' using errcode = '22023';
  end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid checksum' using errcode = '22023';
  end if;
  update public.content_references
  set media_status = 'uploaded', media_size_bytes = v_size, media_sha256 = p_sha256
  where id = p_reference_id;   -- duplicate file in this workspace → 23505 on content_references_ws_sha_uniq
end;
$$;

-- ---------------------------------------------------------------------------
-- Request / cancel analysis (called by signed-in members)
-- ---------------------------------------------------------------------------
create or replace function public.request_analysis(p_reference_id uuid, p_idempotency_key text default null)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_ref public.content_references;
  v_existing uuid;
  v_id uuid := gen_random_uuid();
  v_cost integer := public.analysis_credit_cost();
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  select * into v_ref from public.content_references where id = p_reference_id for update;
  if not found or not public.is_workspace_member(v_ref.workspace_id) then
    raise exception 'reference not found' using errcode = 'P0002';
  end if;

  if p_idempotency_key is not null then
    select analysis_id into v_existing from public.analysis_jobs
    where workspace_id = v_ref.workspace_id and idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
  end if;

  if v_ref.media_status <> 'uploaded' then
    raise exception 'upload a video before requesting an analysis' using errcode = '22023';
  end if;
  if exists (select 1 from public.video_analyses where reference_id = p_reference_id and status in ('queued', 'processing')) then
    raise exception 'an analysis is already in progress for this reference' using errcode = '22023';
  end if;

  insert into public.video_analyses (id, workspace_id, reference_id, status, requested_by, credits_charged)
  values (v_id, v_ref.workspace_id, p_reference_id, 'queued', v_user, v_cost);

  -- Raises 'insufficient credits' (P0001) and rolls back everything above.
  perform public.apply_credit_transaction(
    v_ref.workspace_id, 'consume', -v_cost, 'Video analysis', 'analysis',
    'analysis:' || v_id::text, jsonb_build_object('analysis_id', v_id, 'reference_id', p_reference_id), v_user
  );

  insert into public.analysis_jobs (workspace_id, analysis_id, idempotency_key)
  values (v_ref.workspace_id, v_id, p_idempotency_key);

  perform public.sync_reference_analysis_status(p_reference_id);
  perform public.log_audit_event(
    v_ref.workspace_id, 'analysis.requested', 'video_analysis', v_id::text,
    jsonb_build_object('reference_id', p_reference_id, 'credits', v_cost)
  );
  return v_id;
end;
$$;

create or replace function public.cancel_analysis(p_analysis_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_a public.video_analyses;
  v_job public.analysis_jobs;
begin
  select * into v_a from public.video_analyses where id = p_analysis_id for update;
  if not found or not public.is_workspace_member(v_a.workspace_id) then
    raise exception 'analysis not found' using errcode = 'P0002';
  end if;
  if v_a.requested_by is distinct from auth.uid()
     and not public.has_workspace_role(v_a.workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into v_job from public.analysis_jobs where analysis_id = p_analysis_id for update;

  if v_job.status = 'queued' then
    update public.analysis_jobs set status = 'canceled', finished_at = now(), cancel_requested = true where id = v_job.id;
    update public.video_analyses set status = 'canceled', completed_at = now() where id = p_analysis_id;
    perform public.refund_analysis_credits(p_analysis_id);
    perform public.sync_reference_analysis_status(v_a.reference_id);
    perform public.log_audit_event(v_a.workspace_id, 'analysis.canceled', 'video_analysis', p_analysis_id::text);
    return 'canceled';
  elsif v_job.status = 'running' then
    update public.analysis_jobs set cancel_requested = true where id = v_job.id;
    return 'cancel_requested';
  else
    raise exception 'analysis is not active' using errcode = '22023';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Worker functions (service_role only)
-- ---------------------------------------------------------------------------

-- Claims the next runnable job, or a running job whose worker stopped
-- heart-beating (crash recovery). SKIP LOCKED makes concurrent workers safe.
create or replace function public.claim_analysis_job(p_worker text, p_stale_seconds integer default 600)
returns setof public.analysis_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
  v_ref uuid;
begin
  with candidate as (
    select j.id from public.analysis_jobs j
    where (j.status = 'queued' and j.run_after <= now() and not j.cancel_requested)
       or (j.status = 'running' and j.heartbeat_at < now() - make_interval(secs => p_stale_seconds))
    order by j.run_after, j.created_at
    for update skip locked
    limit 1
  )
  update public.analysis_jobs j
  set status = 'running', locked_by = p_worker, locked_at = now(), heartbeat_at = now(),
      attempts = j.attempts + 1, started_at = coalesce(j.started_at, now())
  from candidate
  where j.id = candidate.id
  returning j.* into v_job;

  if v_job.id is null then
    return;
  end if;
  update public.video_analyses set status = 'processing'
  where id = v_job.analysis_id and status = 'queued'
  returning reference_id into v_ref;
  if v_ref is not null then
    perform public.sync_reference_analysis_status(v_ref);
  end if;
  return next v_job;
end;
$$;

-- Records progress; returns whether cancellation was requested.
create or replace function public.heartbeat_analysis_job(
  p_job_id uuid, p_worker text, p_step text, p_steps jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancel boolean;
begin
  update public.analysis_jobs
  set heartbeat_at = now(), current_step = p_step, steps = coalesce(p_steps, steps)
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning cancel_requested into v_cancel;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  return v_cancel;
end;
$$;

create or replace function public.finish_analysis_job(p_job_id uuid, p_worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
  v_ref uuid;
begin
  update public.analysis_jobs
  set status = 'succeeded', finished_at = now(), locked_by = null, last_error = null
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning * into v_job;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  update public.video_analyses set status = 'completed', completed_at = now(), error = null
  where id = v_job.analysis_id returning reference_id into v_ref;
  perform public.sync_reference_analysis_status(v_ref);
  perform public.log_audit_event(v_job.workspace_id, 'analysis.completed', 'video_analysis', v_job.analysis_id::text, '{}'::jsonb, null);
end;
$$;

-- Retryable failures are re-queued with backoff until max_attempts; then (or
-- for permanent failures) the analysis fails and credits are refunded.
create or replace function public.fail_analysis_job(
  p_job_id uuid, p_worker text, p_error text, p_retryable boolean, p_backoff_seconds integer default 30
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
  v_ref uuid;
  v_err text := left(coalesce(p_error, 'unknown error'), 2000);
begin
  select * into v_job from public.analysis_jobs
  where id = p_job_id and locked_by = p_worker and status = 'running' for update;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;

  if p_retryable and v_job.attempts < v_job.max_attempts and not v_job.cancel_requested then
    update public.analysis_jobs
    set status = 'queued', locked_by = null, locked_at = null, last_error = v_err,
        run_after = now() + make_interval(secs => greatest(p_backoff_seconds, 1))
    where id = p_job_id;
    return 'retry_scheduled';
  end if;

  update public.analysis_jobs
  set status = 'failed', finished_at = now(), locked_by = null, last_error = v_err
  where id = p_job_id;
  update public.video_analyses set status = 'failed', completed_at = now(), error = v_err
  where id = v_job.analysis_id returning reference_id into v_ref;
  perform public.refund_analysis_credits(v_job.analysis_id);
  perform public.sync_reference_analysis_status(v_ref);
  perform public.log_audit_event(v_job.workspace_id, 'analysis.failed', 'video_analysis', v_job.analysis_id::text,
    jsonb_build_object('error', left(v_err, 300)), null);
  return 'failed';
end;
$$;

create or replace function public.cancel_running_analysis_job(p_job_id uuid, p_worker text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.analysis_jobs;
  v_ref uuid;
begin
  update public.analysis_jobs
  set status = 'canceled', finished_at = now(), locked_by = null
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning * into v_job;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  update public.video_analyses set status = 'canceled', completed_at = now()
  where id = v_job.analysis_id returning reference_id into v_ref;
  perform public.refund_analysis_credits(v_job.analysis_id);
  perform public.sync_reference_analysis_status(v_ref);
  perform public.log_audit_event(v_job.workspace_id, 'analysis.canceled', 'video_analysis', v_job.analysis_id::text, '{}'::jsonb, null);
end;
$$;
