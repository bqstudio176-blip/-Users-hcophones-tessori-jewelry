-- =============================================================================
-- Content OS — Phase 4 — Migration 1300: Video Studio functions, RLS, storage
--
-- Object layout (first folder is always the workspace id):
--   <ws>/assets/<asset_id>/<uuid>.<ext>        user upload (reserved path)
--   <ws>/assets/<asset_id>/thumb.jpg|proxy.*   worker-generated
--   <ws>/renders/<render_id>/video.mp4|captions.srt   worker-generated
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.video_timeline_duration(p_timeline jsonb)
returns numeric language sql immutable set search_path = '' as $$
  select coalesce(sum((s ->> 'duration')::numeric), 0)
  from jsonb_array_elements(case when jsonb_typeof(p_timeline -> 'scenes') = 'array' then p_timeline -> 'scenes' else '[]'::jsonb end) s
$$;

-- Structural checks the database enforces regardless of the client (the
-- application validates the full schema with zod before calling).
create or replace function public._video_check_timeline(p_timeline jsonb)
returns void language plpgsql immutable set search_path = '' as $$
declare
  v_n integer;
  v_dur numeric;
  v_max numeric := (public.video_limits() ->> 'max_output_seconds')::numeric;
begin
  if p_timeline is null or jsonb_typeof(p_timeline) <> 'object' or jsonb_typeof(p_timeline -> 'scenes') <> 'array' then
    raise exception 'invalid timeline' using errcode = '22023';
  end if;
  if pg_column_size(p_timeline) > 524288 then
    raise exception 'timeline is too large' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_timeline -> 'scenes');
  if v_n < 1 or v_n > 60 then
    raise exception 'a video needs between 1 and 60 scenes' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_timeline -> 'scenes') s
             where jsonb_typeof(s -> 'duration') <> 'number' or (s ->> 'duration')::numeric < 0.5 or (s ->> 'duration')::numeric > 60) then
    raise exception 'each scene must last between 0.5 and 60 seconds' using errcode = '22023';
  end if;
  v_dur := public.video_timeline_duration(p_timeline);
  if v_dur > v_max then
    raise exception 'the video is %s long; the maximum is %s seconds', round(v_dur, 1), v_max using errcode = '22023';
  end if;
end; $$;

-- Verifies that every asset/take the timeline references belongs to the
-- project's workspace (assets must be ready), then records the links.
create or replace function public._video_sync_assets(p_project_id uuid, p_workspace_id uuid, p_timeline jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_bad integer;
begin
  select coalesce(array_agg(distinct (v #>> '{}')::uuid), '{}') into v_ids
  from jsonb_path_query(p_timeline, 'lax $.**.asset_id') v
  where jsonb_typeof(v) = 'string' and (v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

  if exists (select 1 from jsonb_path_query(p_timeline, 'lax $.**.asset_id') v
             where jsonb_typeof(v) <> 'null' and not ((v #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise exception 'invalid media reference' using errcode = '22023';
  end if;

  select count(*) into v_bad from unnest(v_ids) i
  where not exists (select 1 from public.media_assets a where a.id = i and a.workspace_id = p_workspace_id and a.status = 'ready');
  if v_bad > 0 then
    raise exception 'the timeline uses media that is missing, still processing or from another workspace' using errcode = '22023';
  end if;

  if exists (select 1 from jsonb_path_query(p_timeline, 'lax $.**.take_id') v
             where jsonb_typeof(v) = 'string'
               and not exists (select 1 from public.voiceover_takes t
                               where t.id::text = (v #>> '{}') and t.project_id = p_project_id)) then
    raise exception 'the timeline uses a voiceover take from another project' using errcode = '22023';
  end if;

  delete from public.video_project_assets where project_id = p_project_id and asset_id <> all (v_ids);
  insert into public.video_project_assets (project_id, asset_id, workspace_id)
  select p_project_id, i, p_workspace_id from unnest(v_ids) i
  on conflict do nothing;
end; $$;

create or replace function public._video_add_version(p_project_id uuid, p_source text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.video_timeline_versions (workspace_id, project_id, version, source, timeline, note, created_by)
  select workspace_id, id, timeline_version, p_source, timeline, left(p_note, 500), auth.uid()
  from public.video_projects where id = p_project_id;
end; $$;

create or replace function public._video_script_snapshot(p_script_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'title', s.title,
    'format', s.format,
    'target_duration_seconds', s.target_duration_seconds,
    'version', s.current_version,
    'scenes', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'position', c.position, 'section', c.section, 'scene_title', c.scene_title,
        'estimated_duration_seconds', c.estimated_duration_seconds, 'spoken_text', c.spoken_text,
        'on_screen_text', c.on_screen_text, 'visual_direction', c.visual_direction) order by c.position)
      from public.script_scenes c where c.script_id = s.id), '[]'::jsonb))
  from public.scripts s where s.id = p_script_id
$$;

-- ---------------------------------------------------------------------------
-- Media upload
-- ---------------------------------------------------------------------------
create or replace function public.begin_media_upload(
  p_workspace_id uuid, p_kind public.media_asset_kind, p_mime text, p_size_bytes bigint,
  p_title text, p_rights_confirmed boolean, p_origin text default 'upload'
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_ext text;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_used bigint;
  v_limit bigint;
  v_max bigint := (public.video_limits() ->> 'max_asset_bytes')::bigint;
begin
  if v_user is null or not public.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_rights_confirmed is not true then
    raise exception 'confirm that you own or have the rights to use this file' using errcode = '22023';
  end if;
  if p_origin not in ('upload', 'recording') then
    raise exception 'invalid origin' using errcode = '22023';
  end if;
  v_ext := case
    when p_kind = 'video' and p_mime = 'video/mp4' then 'mp4'
    when p_kind = 'video' and p_mime = 'video/quicktime' then 'mov'
    when p_kind = 'video' and p_mime = 'video/webm' then 'webm'
    when p_kind = 'image' and p_mime = 'image/jpeg' then 'jpg'
    when p_kind = 'image' and p_mime = 'image/png' then 'png'
    when p_kind = 'image' and p_mime = 'image/webp' then 'webp'
    when p_kind = 'audio' and p_mime = 'audio/mpeg' then 'mp3'
    when p_kind = 'audio' and p_mime in ('audio/mp4', 'audio/x-m4a') then 'm4a'
    when p_kind = 'audio' and p_mime in ('audio/wav', 'audio/x-wav') then 'wav'
    when p_kind = 'audio' and p_mime = 'audio/webm' then 'webm'
    when p_kind = 'audio' and p_mime = 'audio/ogg' then 'ogg'
    else null end;
  if v_ext is null then
    raise exception 'unsupported file type for %', p_kind using errcode = '22023';
  end if;
  if p_size_bytes is null or p_size_bytes <= 0 or p_size_bytes > v_max then
    raise exception 'files must be between 1 byte and 1 GB' using errcode = '22023';
  end if;

  -- Serialize quota checks per workspace.
  perform 1 from public.workspaces where id = p_workspace_id for update;
  select coalesce(sum(size_bytes), 0) into v_used from public.media_assets
  where workspace_id = p_workspace_id and status <> 'failed';
  select l.max_bytes into v_limit
  from public.subscriptions s join public.media_storage_limits l on l.plan_id = s.plan_id
  where s.workspace_id = p_workspace_id;
  if v_limit is null then
    select max_bytes into v_limit from public.media_storage_limits where plan_id = 'free';
  end if;
  if v_used + p_size_bytes > v_limit then
    raise exception 'storage quota exceeded for your plan' using errcode = '54000';
  end if;

  v_path := p_workspace_id::text || '/assets/' || v_id::text || '/' || gen_random_uuid()::text || '.' || v_ext;
  insert into public.media_assets (id, workspace_id, kind, origin, title, storage_path, mime, size_bytes, status,
                                   rights_confirmed_by, rights_confirmed_at, created_by)
  values (v_id, p_workspace_id, p_kind, p_origin, left(coalesce(nullif(btrim(p_title), ''), 'Untitled'), 200), v_path, p_mime,
          p_size_bytes, 'pending_upload', v_user, now(), v_user);
  return jsonb_build_object('asset_id', v_id, 'path', v_path);
end; $$;

create or replace function public.complete_media_upload(p_asset_id uuid, p_sha256 text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_a public.media_assets;
  v_size bigint;
  v_job uuid;
begin
  select * into v_a from public.media_assets where id = p_asset_id for update;
  if not found or not public.is_workspace_member(v_a.workspace_id) then
    raise exception 'asset not found' using errcode = 'P0002';
  end if;
  if v_a.status <> 'pending_upload' then
    raise exception 'no upload in progress' using errcode = '22023';
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o where o.bucket_id = 'media' and o.name = v_a.storage_path;
  if not found then
    raise exception 'uploaded file not found' using errcode = '22023';
  end if;
  if v_size is null or v_size <= 0 or v_size > (public.video_limits() ->> 'max_asset_bytes')::bigint then
    raise exception 'uploaded file exceeds 1 GB' using errcode = '22023';
  end if;
  if p_sha256 is not null and p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid checksum' using errcode = '22023';
  end if;
  update public.media_assets set status = 'processing', size_bytes = v_size, sha256 = p_sha256 where id = p_asset_id;
  insert into public.video_jobs (workspace_id, kind, asset_id) values (v_a.workspace_id, 'asset', p_asset_id) returning id into v_job;
  return v_job;
end; $$;

-- ---------------------------------------------------------------------------
-- Projects and timelines
-- ---------------------------------------------------------------------------
create or replace function public.create_video_project(p_script_id uuid, p_title text, p_format text, p_timeline jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_s public.scripts;
  v_id uuid := gen_random_uuid();
begin
  select * into v_s from public.scripts where id = p_script_id;
  if not found or v_user is null or not public.is_workspace_member(v_s.workspace_id) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  if p_format not in ('vertical', 'square', 'portrait') then
    raise exception 'invalid format' using errcode = '22023';
  end if;
  perform public._video_check_timeline(p_timeline);
  insert into public.video_projects (id, workspace_id, script_id, script_version, script_snapshot, title, format, timeline, created_by)
  values (v_id, v_s.workspace_id, v_s.id, v_s.current_version, public._video_script_snapshot(v_s.id),
          left(coalesce(nullif(btrim(p_title), ''), v_s.title), 200), p_format, p_timeline, v_user);
  perform public._video_sync_assets(v_id, v_s.workspace_id, p_timeline);
  perform public._video_add_version(v_id, 'created', null);
  perform public.log_audit_event(v_s.workspace_id, 'video.project_created', 'video_project', v_id::text,
    jsonb_build_object('script_id', v_s.id, 'script_version', v_s.current_version));
  return v_id;
end; $$;

-- Optimistic concurrency: the caller sends the version it edited; a mismatch
-- means someone else saved in between (40001) and nothing is overwritten.
create or replace function public.save_video_timeline(
  p_project_id uuid, p_timeline jsonb, p_expected_version integer, p_snapshot boolean default false, p_note text default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
begin
  select * into v_p from public.video_projects where id = p_project_id for update;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  if v_p.status = 'archived' then
    raise exception 'unarchive the video before editing it' using errcode = '22023';
  end if;
  if v_p.timeline_version <> p_expected_version then
    raise exception 'timeline conflict: version % was saved after you opened it', v_p.timeline_version using errcode = '40001';
  end if;
  perform public._video_check_timeline(p_timeline);
  perform public._video_sync_assets(p_project_id, v_p.workspace_id, p_timeline);
  update public.video_projects
  set timeline = p_timeline, timeline_version = timeline_version + 1,
      status = case when status = 'ready' then 'draft' else status end,
      ready_render_id = case when status = 'ready' then null else ready_render_id end,
      ready_at = case when status = 'ready' then null else ready_at end,
      ready_by = case when status = 'ready' then null else ready_by end
  where id = p_project_id;
  if p_snapshot then
    perform public._video_add_version(p_project_id, 'manual', p_note);
  end if;
  return v_p.timeline_version + 1;
end; $$;

-- Re-snapshots the script and saves the merged timeline (built by the app,
-- shown to the user as a diff before they confirm).
create or replace function public.update_video_from_script(p_project_id uuid, p_timeline jsonb, p_expected_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
  v_v integer;
begin
  select * into v_p from public.video_projects where id = p_project_id;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  if v_p.script_id is null then
    raise exception 'the source script was deleted' using errcode = '22023';
  end if;
  perform public._video_add_version(p_project_id, 'before_restore', 'Before updating from script');
  v_v := public.save_video_timeline(p_project_id, p_timeline, p_expected_version, false, null);
  update public.video_projects
  set script_snapshot = public._video_script_snapshot(v_p.script_id),
      script_version = (select current_version from public.scripts where id = v_p.script_id)
  where id = p_project_id;
  perform public._video_add_version(p_project_id, 'script_update', 'Updated from script');
  return v_v;
end; $$;

create or replace function public.restore_video_timeline(p_project_id uuid, p_version_id uuid)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
  v_t jsonb;
  v_v integer;
begin
  select * into v_p from public.video_projects where id = p_project_id;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  select timeline into v_t from public.video_timeline_versions where id = p_version_id and project_id = p_project_id;
  if not found then
    raise exception 'version not found' using errcode = 'P0002';
  end if;
  perform public._video_add_version(p_project_id, 'before_restore', 'Before restore');
  v_v := public.save_video_timeline(p_project_id, v_t, v_p.timeline_version, false, null);
  perform public._video_add_version(p_project_id, 'restored', 'Restored a previous version');
  return v_v;
end; $$;

create or replace function public.set_video_project_archived(p_project_id uuid, p_archived boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
begin
  select * into v_p from public.video_projects where id = p_project_id for update;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  update public.video_projects
  set status = case when p_archived then 'archived' else 'draft' end,
      ready_render_id = null, ready_at = null, ready_by = null
  where id = p_project_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Voiceover takes
-- ---------------------------------------------------------------------------
create or replace function public.add_voiceover_take(p_project_id uuid, p_asset_id uuid, p_scene_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
  v_a public.media_assets;
  v_id uuid;
begin
  select * into v_p from public.video_projects where id = p_project_id;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  select * into v_a from public.media_assets where id = p_asset_id and workspace_id = v_p.workspace_id;
  if not found or v_a.kind not in ('audio', 'video') or v_a.status not in ('processing', 'ready') then
    raise exception 'choose an audio or video recording from this workspace' using errcode = '22023';
  end if;
  insert into public.voiceover_takes (workspace_id, project_id, asset_id, scene_key, created_by)
  values (v_p.workspace_id, p_project_id, p_asset_id, p_scene_key, auth.uid()) returning id into v_id;
  insert into public.video_jobs (workspace_id, kind, voiceover_id) values (v_p.workspace_id, 'voiceover', v_id);
  return v_id;
end; $$;

-- ---------------------------------------------------------------------------
-- Renders (credits charged when queued, refunded once on failure/cancel)
-- ---------------------------------------------------------------------------
create or replace function public.refund_render_credits(p_render_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_r public.video_renders;
begin
  select * into v_r from public.video_renders where id = p_render_id for update;
  if not found or v_r.credits_charged = 0 or v_r.credits_refunded then
    return;
  end if;
  perform public.apply_credit_transaction(
    v_r.workspace_id, 'refund', v_r.credits_charged, 'Refund: video render not completed',
    'video_render', 'refund:' || v_r.id::text, jsonb_build_object('render_id', v_r.id), null);
  update public.video_renders set credits_refunded = true where id = p_render_id;
end; $$;

create or replace function public.request_render(p_project_id uuid, p_kind text, p_idempotency_key text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_p public.video_projects;
  v_existing uuid;
  v_id uuid := gen_random_uuid();
  v_dur numeric;
  v_cost integer;
  v_drafts integer;
  v_limit integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_kind not in ('draft', 'final') then
    raise exception 'invalid render kind' using errcode = '22023';
  end if;
  select * into v_p from public.video_projects where id = p_project_id for update;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  if p_idempotency_key is not null then
    select render_id into v_existing from public.video_jobs where workspace_id = v_p.workspace_id and idempotency_key = p_idempotency_key;
    if found then
      return v_existing;
    end if;
  end if;
  if v_p.status = 'archived' then
    raise exception 'unarchive the video before rendering' using errcode = '22023';
  end if;
  if exists (select 1 from public.video_renders where project_id = p_project_id and status in ('queued', 'processing')) then
    raise exception 'a render is already in progress for this video' using errcode = '22023';
  end if;
  perform public._video_check_timeline(v_p.timeline);
  perform public._video_sync_assets(p_project_id, v_p.workspace_id, v_p.timeline);
  v_dur := public.video_timeline_duration(v_p.timeline);

  if p_kind = 'draft' then
    select l.draft_renders_per_hour into v_limit
    from public.subscriptions s join public.media_storage_limits l on l.plan_id = s.plan_id where s.workspace_id = v_p.workspace_id;
    select count(*) into v_drafts from public.video_renders
    where workspace_id = v_p.workspace_id and kind = 'draft' and created_at > now() - interval '1 hour';
    if v_drafts >= coalesce(v_limit, 10) then
      raise exception 'draft render limit reached (% per hour)', coalesce(v_limit, 10) using errcode = '54000';
    end if;
  end if;

  v_cost := public.render_credit_cost(p_kind, v_dur);
  insert into public.video_renders (id, workspace_id, project_id, kind, timeline_version, timeline, duration_seconds, settings, credits_charged, requested_by)
  values (v_id, v_p.workspace_id, p_project_id, p_kind, v_p.timeline_version, v_p.timeline, v_dur,
          jsonb_build_object('format', v_p.format, 'fps', v_p.fps), v_cost, v_user);
  if v_cost > 0 then
    -- Raises 'insufficient credits' (P0001) and rolls back everything above.
    perform public.apply_credit_transaction(
      v_p.workspace_id, 'consume', -v_cost, 'Video render (' || p_kind || ')', 'video_render',
      'render:' || v_id::text, jsonb_build_object('render_id', v_id, 'project_id', p_project_id, 'seconds', v_dur), v_user);
  end if;
  insert into public.video_jobs (workspace_id, kind, render_id, idempotency_key) values (v_p.workspace_id, 'render', v_id, p_idempotency_key);
  perform public._video_add_version(p_project_id, 'render', 'Rendered (' || p_kind || ')');
  perform public.log_audit_event(v_p.workspace_id, 'video.render_requested', 'video_render', v_id::text,
    jsonb_build_object('project_id', p_project_id, 'kind', p_kind, 'credits', v_cost, 'seconds', v_dur));
  return v_id;
end; $$;

create or replace function public.cancel_render(p_render_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_r public.video_renders;
  v_job public.video_jobs;
begin
  select * into v_r from public.video_renders where id = p_render_id for update;
  if not found or not public.is_workspace_member(v_r.workspace_id) then
    raise exception 'render not found' using errcode = 'P0002';
  end if;
  if v_r.requested_by is distinct from auth.uid()
     and not public.has_workspace_role(v_r.workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select * into v_job from public.video_jobs where render_id = p_render_id for update;
  if v_job.status = 'queued' then
    update public.video_jobs set status = 'canceled', finished_at = now(), cancel_requested = true where id = v_job.id;
    update public.video_renders set status = 'canceled', completed_at = now() where id = p_render_id;
    perform public.refund_render_credits(p_render_id);
    return 'canceled';
  elsif v_job.status = 'running' then
    update public.video_jobs set cancel_requested = true where id = v_job.id;
    return 'cancel_requested';
  else
    raise exception 'render is not active' using errcode = '22023';
  end if;
end; $$;

create or replace function public.mark_video_ready(p_project_id uuid, p_render_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_p public.video_projects;
  v_r public.video_renders;
begin
  select * into v_p from public.video_projects where id = p_project_id for update;
  if not found or not public.is_workspace_member(v_p.workspace_id) then
    raise exception 'video not found' using errcode = 'P0002';
  end if;
  select * into v_r from public.video_renders where id = p_render_id and project_id = p_project_id;
  if not found then
    raise exception 'render not found' using errcode = 'P0002';
  end if;
  if v_r.kind <> 'final' or v_r.status <> 'completed' then
    raise exception 'only a completed final render can be marked ready' using errcode = '22023';
  end if;
  if v_r.timeline_version <> v_p.timeline_version then
    raise exception 'the timeline changed after this render; render again first' using errcode = '22023';
  end if;
  if coalesce(v_r.checks ->> 'overall', 'fail') not in ('pass', 'warn') then
    raise exception 'resolve the failing pre-publish checks first' using errcode = '22023';
  end if;
  update public.video_projects set status = 'ready', ready_render_id = p_render_id, ready_at = now(), ready_by = auth.uid()
  where id = p_project_id;
  perform public.log_audit_event(v_p.workspace_id, 'video.marked_ready', 'video_project', p_project_id::text,
    jsonb_build_object('render_id', p_render_id));
end; $$;

-- ---------------------------------------------------------------------------
-- Worker functions (service_role only)
-- ---------------------------------------------------------------------------
create or replace function public.claim_video_job(p_worker text, p_stale_seconds integer default 600)
returns setof public.video_jobs language plpgsql security definer set search_path = '' as $$
declare
  v_job public.video_jobs;
begin
  with candidate as (
    select j.id from public.video_jobs j
    where (j.status = 'queued' and j.run_after <= now() and not j.cancel_requested)
       or (j.status = 'running' and j.heartbeat_at < now() - make_interval(secs => p_stale_seconds))
    order by j.run_after, j.created_at
    for update skip locked
    limit 1
  )
  update public.video_jobs j
  set status = 'running', locked_by = p_worker, locked_at = now(), heartbeat_at = now(),
      attempts = j.attempts + 1, started_at = coalesce(j.started_at, now())
  from candidate where j.id = candidate.id
  returning j.* into v_job;
  if v_job.id is null then
    return;
  end if;
  if v_job.kind = 'render' then
    update public.video_renders set status = 'processing' where id = v_job.render_id and status = 'queued';
  elsif v_job.kind = 'voiceover' then
    update public.voiceover_takes set status = 'transcribing' where id = v_job.voiceover_id and status = 'pending';
  end if;
  return next v_job;
end; $$;

create or replace function public.heartbeat_video_job(p_job_id uuid, p_worker text, p_step text, p_steps jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_cancel boolean;
begin
  update public.video_jobs set heartbeat_at = now(), current_step = p_step, steps = coalesce(p_steps, steps)
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning cancel_requested into v_cancel;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  return v_cancel;
end; $$;

-- Puts a job back without consuming an attempt (e.g. a voiceover waiting for
-- its recording to finish processing).
create or replace function public.defer_video_job(p_job_id uuid, p_worker text, p_seconds integer)
returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.video_jobs
  set status = 'queued', locked_by = null, locked_at = null, attempts = greatest(attempts - 1, 0),
      run_after = now() + make_interval(secs => greatest(p_seconds, 1))
  where id = p_job_id and locked_by = p_worker and status = 'running';
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
end; $$;

create or replace function public.finish_video_job(p_job_id uuid, p_worker text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_job public.video_jobs;
begin
  update public.video_jobs set status = 'succeeded', finished_at = now(), locked_by = null, last_error = null
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning * into v_job;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  if v_job.kind = 'asset' then
    update public.media_assets set status = 'ready', error = null where id = v_job.asset_id;
  elsif v_job.kind = 'voiceover' then
    update public.voiceover_takes set status = 'completed' where id = v_job.voiceover_id and status = 'transcribing';
  else
    update public.video_renders set status = 'completed', completed_at = now(), error = null where id = v_job.render_id;
    perform public.log_audit_event(v_job.workspace_id, 'video.render_completed', 'video_render', v_job.render_id::text, '{}'::jsonb, null);
  end if;
end; $$;

create or replace function public._video_job_failed(v_job public.video_jobs, p_error text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if v_job.kind = 'asset' then
    update public.media_assets set status = 'failed', error = left(p_error, 1000) where id = v_job.asset_id;
  elsif v_job.kind = 'voiceover' then
    update public.voiceover_takes set status = 'failed', error = left(p_error, 1000) where id = v_job.voiceover_id;
  else
    update public.video_renders set status = 'failed', completed_at = now(), error = left(p_error, 2000) where id = v_job.render_id;
    perform public.refund_render_credits(v_job.render_id);
    perform public.log_audit_event(v_job.workspace_id, 'video.render_failed', 'video_render', v_job.render_id::text,
      jsonb_build_object('error', left(p_error, 300)), null);
  end if;
end; $$;

create or replace function public.fail_video_job(p_job_id uuid, p_worker text, p_error text, p_retryable boolean, p_backoff_seconds integer default 30)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_job public.video_jobs;
  v_err text := left(coalesce(p_error, 'unknown error'), 2000);
begin
  select * into v_job from public.video_jobs where id = p_job_id and locked_by = p_worker and status = 'running' for update;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  if p_retryable and v_job.attempts < v_job.max_attempts and not v_job.cancel_requested then
    update public.video_jobs
    set status = 'queued', locked_by = null, locked_at = null, last_error = v_err,
        run_after = now() + make_interval(secs => greatest(p_backoff_seconds, 1))
    where id = p_job_id;
    return 'retry_scheduled';
  end if;
  update public.video_jobs set status = 'failed', finished_at = now(), locked_by = null, last_error = v_err where id = p_job_id;
  perform public._video_job_failed(v_job, v_err);
  return 'failed';
end; $$;

create or replace function public.cancel_running_video_job(p_job_id uuid, p_worker text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_job public.video_jobs;
begin
  update public.video_jobs set status = 'canceled', finished_at = now(), locked_by = null
  where id = p_job_id and locked_by = p_worker and status = 'running'
  returning * into v_job;
  if not found then
    raise exception 'job % is not held by worker %', p_job_id, p_worker using errcode = '55000';
  end if;
  if v_job.kind = 'render' then
    update public.video_renders set status = 'canceled', completed_at = now() where id = v_job.render_id;
    perform public.refund_render_credits(v_job.render_id);
  else
    perform public._video_job_failed(v_job, 'Canceled');
  end if;
end; $$;

-- ---------------------------------------------------------------------------
-- Feedback on renders (extends the Phase 3 feedback table)
-- ---------------------------------------------------------------------------
alter table public.script_feedback drop constraint if exists script_feedback_target_type_check;
alter table public.script_feedback add constraint script_feedback_target_type_check
  check (target_type in ('idea', 'hook', 'script', 'recommendation', 'quality_report', 'strategy', 'video_render'));

create or replace function public.script_feedback_check_target()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_ok boolean;
begin
  v_ok := case new.target_type
    when 'idea' then exists (select 1 from public.generated_ideas where id = new.target_id and workspace_id = new.workspace_id)
    when 'recommendation' then exists (select 1 from public.generated_ideas where id = new.target_id and workspace_id = new.workspace_id)
    when 'hook' then exists (select 1 from public.generated_hooks where id = new.target_id and workspace_id = new.workspace_id)
    when 'script' then exists (select 1 from public.scripts where id = new.target_id and workspace_id = new.workspace_id)
    when 'quality_report' then exists (select 1 from public.script_quality_reports where id = new.target_id and workspace_id = new.workspace_id)
    when 'strategy' then exists (select 1 from public.content_strategies where id = new.target_id and workspace_id = new.workspace_id)
    when 'video_render' then exists (select 1 from public.video_renders where id = new.target_id and workspace_id = new.workspace_id)
    else false end;
  if not v_ok then
    raise exception 'feedback target not found in this workspace' using errcode = '23514';
  end if;
  return new;
end; $$;

-- ---------------------------------------------------------------------------
-- RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.media_storage_limits    enable row level security;
alter table public.media_assets            enable row level security;
alter table public.video_projects          enable row level security;
alter table public.video_project_assets    enable row level security;
alter table public.video_timeline_versions enable row level security;
alter table public.voiceover_takes         enable row level security;
alter table public.video_renders           enable row level security;
alter table public.video_jobs              enable row level security;

revoke all on
  public.media_storage_limits, public.media_assets, public.video_projects, public.video_project_assets,
  public.video_timeline_versions, public.voiceover_takes, public.video_renders, public.video_jobs
from anon, authenticated;

revoke execute on function
  public.video_limits(), public.render_credit_cost(text, numeric), public.video_timeline_duration(jsonb),
  public._video_check_timeline(jsonb), public._video_sync_assets(uuid, uuid, jsonb), public._video_add_version(uuid, text, text),
  public._video_script_snapshot(uuid), public.video_check_scope(),
  public.begin_media_upload(uuid, public.media_asset_kind, text, bigint, text, boolean, text),
  public.complete_media_upload(uuid, text),
  public.create_video_project(uuid, text, text, jsonb),
  public.save_video_timeline(uuid, jsonb, integer, boolean, text),
  public.update_video_from_script(uuid, jsonb, integer),
  public.restore_video_timeline(uuid, uuid),
  public.set_video_project_archived(uuid, boolean),
  public.add_voiceover_take(uuid, uuid, text),
  public.refund_render_credits(uuid),
  public.request_render(uuid, text, text),
  public.cancel_render(uuid),
  public.mark_video_ready(uuid, uuid),
  public.claim_video_job(text, integer), public.heartbeat_video_job(uuid, text, text, jsonb),
  public.defer_video_job(uuid, text, integer), public.finish_video_job(uuid, text),
  public._video_job_failed(public.video_jobs, text),
  public.fail_video_job(uuid, text, text, boolean, integer), public.cancel_running_video_job(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.video_limits(), public.render_credit_cost(text, numeric), public.video_timeline_duration(jsonb),
  public.begin_media_upload(uuid, public.media_asset_kind, text, bigint, text, boolean, text),
  public.complete_media_upload(uuid, text),
  public.create_video_project(uuid, text, text, jsonb),
  public.save_video_timeline(uuid, jsonb, integer, boolean, text),
  public.update_video_from_script(uuid, jsonb, integer),
  public.restore_video_timeline(uuid, uuid),
  public.set_video_project_archived(uuid, boolean),
  public.add_voiceover_take(uuid, uuid, text),
  public.request_render(uuid, text, text),
  public.cancel_render(uuid),
  public.mark_video_ready(uuid, uuid)
to authenticated;

grant execute on function
  public.video_limits(), public.render_credit_cost(text, numeric), public.video_timeline_duration(jsonb),
  public.claim_video_job(text, integer), public.heartbeat_video_job(uuid, text, text, jsonb),
  public.defer_video_job(uuid, text, integer), public.finish_video_job(uuid, text),
  public.fail_video_job(uuid, text, text, boolean, integer), public.cancel_running_video_job(uuid, text),
  public.refund_render_credits(uuid)
to service_role;

grant select on
  public.media_storage_limits, public.media_assets, public.video_projects, public.video_project_assets,
  public.video_timeline_versions, public.voiceover_takes, public.video_renders, public.video_jobs
to authenticated;

grant update (title, tags) on public.media_assets to authenticated;
grant delete on public.media_assets to authenticated;
grant update (title) on public.video_projects to authenticated;
grant delete on public.video_projects to authenticated;
grant delete on public.voiceover_takes to authenticated;

-- History stays append-only for the service role too.
revoke update, delete, truncate on public.video_timeline_versions from service_role;

create policy media_storage_limits_select on public.media_storage_limits for select to authenticated using (true);

create policy media_assets_select on public.media_assets for select to authenticated using (public.is_workspace_member(workspace_id));
create policy media_assets_update on public.media_assets for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
-- Delete only media that no timeline or voiceover take still uses.
create policy media_assets_delete on public.media_assets for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and not exists (select 1 from public.video_project_assets l where l.asset_id = id)
         and not exists (select 1 from public.voiceover_takes t where t.asset_id = id));

create policy video_projects_select on public.video_projects for select to authenticated using (public.is_workspace_member(workspace_id));
create policy video_projects_update on public.video_projects for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy video_projects_delete on public.video_projects for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (created_by = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
         and not exists (select 1 from public.video_renders r where r.project_id = id and r.status in ('queued', 'processing')));

create policy video_project_assets_select on public.video_project_assets for select to authenticated using (public.is_workspace_member(workspace_id));
create policy video_timeline_versions_select on public.video_timeline_versions for select to authenticated using (public.is_workspace_member(workspace_id));
create policy voiceover_takes_select on public.voiceover_takes for select to authenticated using (public.is_workspace_member(workspace_id));
create policy voiceover_takes_delete on public.voiceover_takes for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and not exists (select 1 from public.video_projects p where p.id = project_id and p.timeline::text like '%' || id::text || '%'));
create policy video_renders_select on public.video_renders for select to authenticated using (public.is_workspace_member(workspace_id));
create policy video_jobs_select on public.video_jobs for select to authenticated using (public.is_workspace_member(workspace_id));

-- ---------------------------------------------------------------------------
-- Storage: widen the media bucket for Video Studio and replace the policies
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    raise notice 'storage schema not present; skipping bucket and storage policies';
    return;
  end if;

  update storage.buckets
  set file_size_limit = 1073741824,
      allowed_mime_types = array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg', 'image/png', 'image/webp',
                                 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/webm',
                                 'audio/ogg', 'text/plain']
  where id = 'media';

  drop policy if exists media_insert_reserved on storage.objects;
  create policy media_insert_reserved on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'media'
      and (
        exists (select 1 from public.content_references r
                where r.media_path = name and r.media_status = 'pending_upload' and public.is_workspace_member(r.workspace_id))
        or exists (select 1 from public.media_assets a
                   where a.storage_path = name and a.status = 'pending_upload' and public.is_workspace_member(a.workspace_id))
      )
    );

  drop policy if exists media_delete_orphan on storage.objects;
  create policy media_delete_orphan on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'media'
      and public.is_workspace_member(public.storage_workspace_id(name))
      and not exists (select 1 from public.content_references r where r.media_path = name and r.media_status <> 'pending_upload')
      and not exists (select 1 from public.video_analyses a
                      where split_part(name, '/', 2) = 'analyses' and a.id::text = split_part(name, '/', 3))
      and not exists (select 1 from public.media_assets a
                      where split_part(name, '/', 2) = 'assets' and a.id::text = split_part(name, '/', 3)
                        and (a.status <> 'pending_upload' or a.storage_path <> name))
      and not exists (select 1 from public.video_renders v
                      where split_part(name, '/', 2) = 'renders' and v.id::text = split_part(name, '/', 3))
    );
end $$;
