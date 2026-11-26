-- =============================================================================
-- Content OS — Phase 3 — Migration 1000: creative functions, accounting, RLS
--
-- Billing policy (documented in docs/AI_ARCHITECTURE.md §6): credits are
-- charged only when an agent returns a schema-valid, validated result.
-- Failed, refused, invalid or rejected runs are recorded with 0 credits.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Feedback target must exist in the same workspace (polymorphic reference)
-- ---------------------------------------------------------------------------
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
    else false end;
  if not v_ok then
    raise exception 'feedback target not found in this workspace' using errcode = '23514';
  end if;
  return new;
end; $$;
create trigger script_feedback_check_target before insert on public.script_feedback
  for each row execute function public.script_feedback_check_target();

-- ---------------------------------------------------------------------------
-- AI usage: pre-flight check (credits + limits) and run recording
-- ---------------------------------------------------------------------------
create or replace function public.check_ai_usage(p_workspace_id uuid, p_agent public.creative_agent)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_cost integer;
  v_balance integer;
  v_limits public.ai_usage_limits;
  v_hour integer;
  v_day integer;
  v_user_min integer;
  v_reason text := null;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select credits into v_cost from public.ai_agent_pricing where agent = p_agent;
  select balance into v_balance from public.usage_credits where workspace_id = p_workspace_id;
  select l.* into v_limits from public.ai_usage_limits l
    join public.subscriptions s on s.plan_id = l.plan_id where s.workspace_id = p_workspace_id;
  if v_limits.plan_id is null then
    v_limits := row('fallback', 10, 30, 3)::public.ai_usage_limits;
  end if;
  select count(*) into v_hour from public.ai_agent_runs where workspace_id = p_workspace_id and created_at > now() - interval '1 hour';
  select count(*) into v_day from public.ai_agent_runs where workspace_id = p_workspace_id and created_at > now() - interval '1 day';
  select count(*) into v_user_min from public.ai_agent_runs where created_by = auth.uid() and created_at > now() - interval '1 minute';

  if coalesce(v_balance, 0) < coalesce(v_cost, 0) then v_reason := 'insufficient_credits';
  elsif v_user_min >= v_limits.max_runs_per_user_min then v_reason := 'rate_limited';
  elsif v_hour >= v_limits.max_runs_per_hour then v_reason := 'hourly_limit';
  elsif v_day >= v_limits.max_runs_per_day then v_reason := 'daily_limit';
  end if;

  return jsonb_build_object(
    'allowed', v_reason is null, 'reason', v_reason, 'credits_required', coalesce(v_cost, 0),
    'balance', coalesce(v_balance, 0), 'runs_last_hour', v_hour, 'max_runs_per_hour', v_limits.max_runs_per_hour,
    'runs_last_day', v_day, 'max_runs_per_day', v_limits.max_runs_per_day,
    'runs_last_minute_user', v_user_min, 'max_runs_per_user_min', v_limits.max_runs_per_user_min
  );
end; $$;

create or replace function public.record_ai_agent_run(
  p_workspace_id uuid,
  p_project_id uuid,
  p_agent public.creative_agent,
  p_status text,
  p_provider text,
  p_model text,
  p_prompt_version text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_duration_ms integer,
  p_cost_usd numeric,
  p_error text,
  p_request_summary jsonb default '{}'::jsonb,
  p_invocations jsonb default '[]'::jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_credits integer := 0;
  v_inv jsonb;
begin
  if not public.is_workspace_member(p_workspace_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_project_id is not null and not exists (
    select 1 from public.creative_projects where id = p_project_id and workspace_id = p_workspace_id
  ) then
    raise exception 'project not found' using errcode = 'P0002';
  end if;
  if p_status not in ('succeeded', 'failed', 'invalid_output', 'refused', 'rejected') then
    raise exception 'invalid status' using errcode = '22023';
  end if;

  if p_status = 'succeeded' then
    select credits into v_credits from public.ai_agent_pricing where agent = p_agent;
    v_credits := coalesce(v_credits, 0);
  end if;

  insert into public.ai_agent_runs (id, workspace_id, project_id, agent, status, provider, model, prompt_version,
    input_tokens, output_tokens, duration_ms, cost_usd, credits_charged, error, request_summary, created_by)
  values (v_run_id, p_workspace_id, p_project_id, p_agent, p_status, left(p_provider, 40), left(p_model, 80), left(p_prompt_version, 40),
    greatest(p_input_tokens, 0), greatest(p_output_tokens, 0), greatest(p_duration_ms, 0), p_cost_usd, v_credits,
    left(p_error, 1000), coalesce(p_request_summary, '{}'::jsonb), auth.uid());

  if v_credits > 0 then
    -- Raises insufficient credits (P0001) and rolls back the run row.
    perform public.apply_credit_transaction(
      p_workspace_id, 'consume', -v_credits, 'AI ' || p_agent::text || ' agent', 'creative_' || p_agent::text,
      'agent-run:' || v_run_id::text, jsonb_build_object('agent_run_id', v_run_id, 'project_id', p_project_id), auth.uid()
    );
  end if;

  for v_inv in select * from jsonb_array_elements(coalesce(p_invocations, '[]'::jsonb)) loop
    insert into public.ai_invocations (workspace_id, analysis_id, agent_run_id, purpose, provider, model, prompt_version,
      status, input_tokens, output_tokens, latency_ms, cost_usd, error)
    values (p_workspace_id, null, v_run_id, left(v_inv ->> 'purpose', 60), left(coalesce(v_inv ->> 'provider', p_provider), 40),
      left(coalesce(v_inv ->> 'model', p_model), 80), left(v_inv ->> 'prompt_version', 40),
      case when v_inv ->> 'status' in ('succeeded', 'failed', 'invalid_output', 'refused') then v_inv ->> 'status' else 'failed' end,
      nullif(v_inv ->> 'input_tokens', '')::int, nullif(v_inv ->> 'output_tokens', '')::int,
      nullif(v_inv ->> 'latency_ms', '')::int, nullif(v_inv ->> 'cost_usd', '')::numeric, left(v_inv ->> 'error', 1000));
  end loop;

  if p_status = 'succeeded' then
    perform public.log_audit_event(p_workspace_id, 'creative.agent_run', 'ai_agent_run', v_run_id::text,
      jsonb_build_object('agent', p_agent, 'credits', v_credits, 'project_id', p_project_id));
  end if;
  return jsonb_build_object('run_id', v_run_id, 'credits_charged', v_credits);
end; $$;

-- ---------------------------------------------------------------------------
-- Scripts: snapshots, versions, atomic content replacement, reorder, restore
-- ---------------------------------------------------------------------------
create or replace function public.script_snapshot(p_script_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'title', s.title, 'tone', s.tone, 'target_duration_seconds', s.target_duration_seconds, 'sections', s.sections,
    'scenes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', c.id, 'position', c.position, 'section', c.section, 'scene_title', c.scene_title,
        'estimated_duration_seconds', c.estimated_duration_seconds, 'spoken_text', c.spoken_text,
        'visual_direction', c.visual_direction, 'camera_direction', c.camera_direction, 'on_screen_text', c.on_screen_text,
        'audio_direction', c.audio_direction, 'transition', c.transition, 'creative_purpose', c.creative_purpose,
        'is_locked', c.is_locked) order by c.position)
      from public.script_scenes c where c.script_id = s.id), '[]'::jsonb))
  from public.scripts s where s.id = p_script_id;
$$;

create or replace function public._script_add_version(p_script_id uuid, p_source text, p_note text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.scripts;
  v_next integer;
begin
  select * into v_s from public.scripts where id = p_script_id for update;
  v_next := v_s.current_version + 1;
  insert into public.script_versions (workspace_id, script_id, version, source, snapshot, note, created_by)
  values (v_s.workspace_id, p_script_id, v_next, p_source, public.script_snapshot(p_script_id), left(p_note, 500), auth.uid());
  update public.scripts set current_version = v_next where id = p_script_id;
  return v_next;
end; $$;

create or replace function public.save_script_version(p_script_id uuid, p_note text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.scripts where id = p_script_id;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  return public._script_add_version(p_script_id, 'manual_save', p_note);
end; $$;

-- Replaces sections + scenes atomically and records versions.
--   'generated'        : first content of a new script (or AI alternative)
--   'ai_edit_applied'  : user confirmed an AI proposal (locked scenes must be unchanged)
--   'restored'         : restoring a previous version
-- Before AI edits and restores, the current content is snapshotted first so
-- the operation is always reversible.
create or replace function public.replace_script_content(
  p_script_id uuid, p_title text, p_sections jsonb, p_scenes jsonb, p_source text, p_note text default null
)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_s public.scripts;
  v_scene jsonb;
  v_pos integer := 0;
  v_locked record;
begin
  select * into v_s from public.scripts where id = p_script_id for update;
  if not found or not public.is_workspace_member(v_s.workspace_id) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  if p_source not in ('generated', 'ai_edit_applied', 'restored') then
    raise exception 'invalid source' using errcode = '22023';
  end if;
  if jsonb_typeof(p_scenes) <> 'array' or jsonb_array_length(p_scenes) = 0 or jsonb_array_length(p_scenes) > 60 then
    raise exception 'a script needs between 1 and 60 scenes' using errcode = '22023';
  end if;

  if p_source = 'ai_edit_applied' then
    for v_locked in select * from public.script_scenes where script_id = p_script_id and is_locked loop
      if not exists (
        select 1 from jsonb_array_elements(p_scenes) e
        where e ->> 'id' = v_locked.id::text
          and coalesce(e ->> 'spoken_text', '') = v_locked.spoken_text
          and coalesce(e ->> 'visual_direction', '') = v_locked.visual_direction
          and coalesce(e ->> 'on_screen_text', '') = v_locked.on_screen_text
          and coalesce(e ->> 'scene_title', '') = v_locked.scene_title
      ) then
        raise exception 'locked scenes cannot be changed or removed by AI edits' using errcode = '42501';
      end if;
    end loop;
  end if;

  if v_s.current_version > 0 and p_source in ('ai_edit_applied', 'restored') then
    perform public._script_add_version(p_script_id,
      case when p_source = 'restored' then 'before_restore' else 'before_ai_edit' end, null);
  end if;

  delete from public.script_scenes where script_id = p_script_id;
  for v_scene in select * from jsonb_array_elements(p_scenes) loop
    v_pos := v_pos + 1;
    insert into public.script_scenes (workspace_id, script_id, position, section, scene_title, estimated_duration_seconds,
      spoken_text, visual_direction, camera_direction, on_screen_text, audio_direction, transition, creative_purpose, is_locked)
    values (v_s.workspace_id, p_script_id, v_pos, coalesce(v_scene ->> 'section', 'main_development'),
      coalesce(v_scene ->> 'scene_title', 'Scene ' || v_pos), (v_scene ->> 'estimated_duration_seconds')::numeric,
      coalesce(v_scene ->> 'spoken_text', ''), coalesce(v_scene ->> 'visual_direction', ''), coalesce(v_scene ->> 'camera_direction', ''),
      coalesce(v_scene ->> 'on_screen_text', ''), coalesce(v_scene ->> 'audio_direction', ''), coalesce(v_scene ->> 'transition', ''),
      coalesce(v_scene ->> 'creative_purpose', ''), coalesce((v_scene ->> 'is_locked')::boolean, false));
  end loop;

  update public.scripts
  set title = coalesce(nullif(btrim(p_title), ''), title),
      sections = coalesce(p_sections, sections),
      pending_proposal = null
  where id = p_script_id;

  return public._script_add_version(p_script_id, p_source, p_note);
end; $$;

create or replace function public.restore_script_version(p_script_id uuid, p_version integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_snap jsonb;
  v_ws uuid;
begin
  select workspace_id into v_ws from public.scripts where id = p_script_id;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  select snapshot into v_snap from public.script_versions where script_id = p_script_id and version = p_version;
  if v_snap is null then
    raise exception 'version not found' using errcode = 'P0002';
  end if;
  return public.replace_script_content(p_script_id, v_snap ->> 'title', v_snap -> 'sections', v_snap -> 'scenes',
    'restored', 'Restored version ' || p_version);
end; $$;

create or replace function public.reorder_script_scenes(p_script_id uuid, p_scene_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_count integer;
begin
  select workspace_id into v_ws from public.scripts where id = p_script_id for update;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  select count(*) into v_count from public.script_scenes where script_id = p_script_id;
  if v_count <> cardinality(p_scene_ids) or (select count(distinct x) from unnest(p_scene_ids) x) <> v_count
     or exists (select 1 from unnest(p_scene_ids) x where not exists (select 1 from public.script_scenes c where c.id = x and c.script_id = p_script_id)) then
    raise exception 'the new order must list every scene of the script exactly once' using errcode = '22023';
  end if;
  update public.script_scenes c set position = o.ord
  from unnest(p_scene_ids) with ordinality as o(id, ord)
  where c.id = o.id and c.script_id = p_script_id;
end; $$;

-- Inserts a scene at a position (1-based), shifting the following scenes.
create or replace function public.insert_script_scene(p_script_id uuid, p_position integer, p_scene jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
  v_max integer;
  v_pos integer;
  v_id uuid;
begin
  select workspace_id into v_ws from public.scripts where id = p_script_id for update;
  if v_ws is null or not public.is_workspace_member(v_ws) then
    raise exception 'script not found' using errcode = 'P0002';
  end if;
  select coalesce(max(position), 0) into v_max from public.script_scenes where script_id = p_script_id;
  if v_max >= 60 then
    raise exception 'a script can have at most 60 scenes' using errcode = '22023';
  end if;
  v_pos := least(greatest(coalesce(p_position, v_max + 1), 1), v_max + 1);
  update public.script_scenes set position = position + 1 where script_id = p_script_id and position >= v_pos;
  insert into public.script_scenes (workspace_id, script_id, position, section, scene_title, estimated_duration_seconds,
    spoken_text, visual_direction, camera_direction, on_screen_text, audio_direction, transition, creative_purpose)
  values (v_ws, p_script_id, v_pos, coalesce(p_scene ->> 'section', 'main_development'), coalesce(p_scene ->> 'scene_title', 'New scene'),
    coalesce((p_scene ->> 'estimated_duration_seconds')::numeric, 3), coalesce(p_scene ->> 'spoken_text', ''),
    coalesce(p_scene ->> 'visual_direction', ''), coalesce(p_scene ->> 'camera_direction', ''), coalesce(p_scene ->> 'on_screen_text', ''),
    coalesce(p_scene ->> 'audio_direction', ''), coalesce(p_scene ->> 'transition', ''), coalesce(p_scene ->> 'creative_purpose', ''))
  returning id into v_id;
  return v_id;
end; $$;

create or replace function public.delete_script_scene(p_scene_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_scene public.script_scenes;
begin
  select * into v_scene from public.script_scenes where id = p_scene_id;
  if not found or not public.is_workspace_member(v_scene.workspace_id) then
    raise exception 'scene not found' using errcode = 'P0002';
  end if;
  perform 1 from public.scripts where id = v_scene.script_id for update;
  if (select count(*) from public.script_scenes where script_id = v_scene.script_id) <= 1 then
    raise exception 'a script needs at least one scene' using errcode = '22023';
  end if;
  delete from public.script_scenes where id = p_scene_id;
  update public.script_scenes set position = position - 1 where script_id = v_scene.script_id and position > v_scene.position;
end; $$;

-- ---------------------------------------------------------------------------
-- Rule governance
-- ---------------------------------------------------------------------------
create or replace function public.set_creative_rule_status(p_rule_id uuid, p_status public.creative_rule_status)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_rule public.creative_rules;
begin
  select * into v_rule from public.creative_rules where id = p_rule_id for update;
  if not found then
    raise exception 'rule not found' using errcode = 'P0002';
  end if;
  if v_rule.workspace_id is null then
    if not public.is_platform_admin() then
      raise exception 'only platform admins can change global rules' using errcode = '42501';
    end if;
  elsif not public.is_workspace_member(v_rule.workspace_id) then
    raise exception 'rule not found' using errcode = 'P0002';
  elsif p_status in ('approved', 'disabled')
     and not public.has_workspace_role(v_rule.workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'only owners and admins can approve or disable rules' using errcode = '42501';
  elsif p_status = 'pending_approval' and v_rule.status not in ('draft', 'disabled') then
    raise exception 'only draft or disabled rules can be submitted' using errcode = '22023';
  end if;

  update public.creative_rules
  set status = p_status,
      approved_by = case when p_status = 'approved' then auth.uid() else null end,
      approved_at = case when p_status = 'approved' then now() else null end
  where id = p_rule_id;

  perform public.log_audit_event(v_rule.workspace_id, 'creative.rule_status', 'creative_rule', p_rule_id::text,
    jsonb_build_object('from', v_rule.status, 'to', p_status, 'slug', v_rule.slug));
end; $$;

create or replace function public.set_creative_rule_override(p_workspace_id uuid, p_rule_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'only owners and admins can enable or disable library rules' using errcode = '42501';
  end if;
  if not exists (select 1 from public.creative_rules where id = p_rule_id and workspace_id is null) then
    raise exception 'global rule not found' using errcode = 'P0002';
  end if;
  insert into public.creative_rule_overrides (workspace_id, rule_id, enabled, updated_by)
  values (p_workspace_id, p_rule_id, p_enabled, auth.uid())
  on conflict (workspace_id, rule_id) do update set enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = now();
end; $$;

create or replace function public.set_creative_preference_approval(p_preference_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_ws uuid;
begin
  select workspace_id into v_ws from public.creative_preferences where id = p_preference_id;
  if v_ws is null or not public.has_workspace_role(v_ws, array['owner','admin']::public.workspace_role[]) then
    raise exception 'only owners and admins can approve preferences' using errcode = '42501';
  end if;
  update public.creative_preferences
  set approved = p_approved, approved_by = case when p_approved then auth.uid() else null end
  where id = p_preference_id;
end; $$;

-- ---------------------------------------------------------------------------
-- RLS + privileges
-- ---------------------------------------------------------------------------
alter table public.ai_agent_pricing       enable row level security;
alter table public.ai_usage_limits        enable row level security;
alter table public.creative_projects      enable row level security;
alter table public.content_strategies     enable row level security;
alter table public.creative_rules         enable row level security;
alter table public.creative_rule_tags     enable row level security;
alter table public.creative_rule_versions enable row level security;
alter table public.creative_rule_overrides enable row level security;
alter table public.ai_agent_runs          enable row level security;
alter table public.generated_ideas        enable row level security;
alter table public.generated_hooks        enable row level security;
alter table public.scripts                enable row level security;
alter table public.script_scenes          enable row level security;
alter table public.script_versions        enable row level security;
alter table public.script_quality_reports enable row level security;
alter table public.script_feedback        enable row level security;
alter table public.creative_preferences   enable row level security;

revoke all on
  public.ai_agent_pricing, public.ai_usage_limits, public.creative_projects, public.content_strategies,
  public.creative_rules, public.creative_rule_tags, public.creative_rule_versions, public.creative_rule_overrides,
  public.ai_agent_runs, public.generated_ideas, public.generated_hooks, public.scripts, public.script_scenes,
  public.script_versions, public.script_quality_reports, public.script_feedback, public.creative_preferences
from anon, authenticated;

revoke execute on function
  public.content_strategies_check_scope(), public.creative_rules_versioning(), public.creative_outputs_check_scope(),
  public.script_children_check_scope(), public.script_feedback_check_target(),
  public.check_ai_usage(uuid, public.creative_agent),
  public.record_ai_agent_run(uuid, uuid, public.creative_agent, text, text, text, text, integer, integer, integer, numeric, text, jsonb, jsonb),
  public.script_snapshot(uuid), public._script_add_version(uuid, text, text), public.save_script_version(uuid, text),
  public.replace_script_content(uuid, text, jsonb, jsonb, text, text), public.restore_script_version(uuid, integer),
  public.reorder_script_scenes(uuid, uuid[]), public.insert_script_scene(uuid, integer, jsonb), public.delete_script_scene(uuid),
  public.set_creative_rule_status(uuid, public.creative_rule_status), public.set_creative_rule_override(uuid, uuid, boolean),
  public.set_creative_preference_approval(uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.check_ai_usage(uuid, public.creative_agent),
  public.record_ai_agent_run(uuid, uuid, public.creative_agent, text, text, text, text, integer, integer, integer, numeric, text, jsonb, jsonb),
  public.save_script_version(uuid, text),
  public.replace_script_content(uuid, text, jsonb, jsonb, text, text),
  public.restore_script_version(uuid, integer),
  public.reorder_script_scenes(uuid, uuid[]),
  public.insert_script_scene(uuid, integer, jsonb),
  public.delete_script_scene(uuid),
  public.set_creative_rule_status(uuid, public.creative_rule_status),
  public.set_creative_rule_override(uuid, uuid, boolean),
  public.set_creative_preference_approval(uuid, boolean)
to authenticated;

grant select on
  public.ai_agent_pricing, public.ai_usage_limits, public.creative_projects, public.content_strategies,
  public.creative_rules, public.creative_rule_tags, public.creative_rule_versions, public.creative_rule_overrides,
  public.ai_agent_runs, public.generated_ideas, public.generated_hooks, public.scripts, public.script_scenes,
  public.script_versions, public.script_quality_reports, public.script_feedback, public.creative_preferences
to authenticated;

grant insert (workspace_id, name, description, created_by) on public.creative_projects to authenticated;
grant update (name, description, status) on public.creative_projects to authenticated;
grant delete on public.creative_projects to authenticated;

grant insert (workspace_id, project_id, name, niche, target_audience, objective, main_topic, tone, platform, preferred_format,
              duration_seconds, reference_ids, manual_topics, restrictions, desired_cta, use_content_history, created_by)
  on public.content_strategies to authenticated;
grant update (name, niche, target_audience, objective, main_topic, tone, platform, preferred_format, duration_seconds,
              reference_ids, manual_topics, restrictions, desired_cta, use_content_history, research_brief, recommendations, selected_rule_ids)
  on public.content_strategies to authenticated;
grant delete on public.content_strategies to authenticated;

grant insert (workspace_id, slug, name, category, description, objective, application_conditions, avoidance_conditions, example,
              recommended_formats, objectives, tones_excluded, min_duration_seconds, max_duration_seconds, complexity_level,
              evidence_type, evidence_note, status, created_by)
  on public.creative_rules to authenticated;
grant update (name, category, description, objective, application_conditions, avoidance_conditions, example, recommended_formats,
              objectives, tones_excluded, min_duration_seconds, max_duration_seconds, complexity_level, evidence_type, evidence_note)
  on public.creative_rules to authenticated;
grant delete on public.creative_rules to authenticated;
grant insert, delete on public.creative_rule_tags to authenticated;

grant insert (workspace_id, project_id, strategy_id, agent_run_id, kind, title, body, reasoning, provenance) on public.generated_ideas to authenticated;
grant update (is_favorite) on public.generated_ideas to authenticated;
grant delete on public.generated_ideas to authenticated;

grant insert (workspace_id, project_id, strategy_id, agent_run_id, text, original_text, category, mechanism, visual_opening, delivery,
              estimated_duration_seconds, rationale, rule_ids) on public.generated_hooks to authenticated;
grant update (text, is_favorite) on public.generated_hooks to authenticated;
grant delete on public.generated_hooks to authenticated;

grant insert (workspace_id, project_id, strategy_id, hook_id, parent_script_id, title, format, target_duration_seconds, tone, rule_ids, created_by)
  on public.scripts to authenticated;
grant update (title, tone, status, notes, sections, target_duration_seconds, pending_proposal) on public.scripts to authenticated;
grant delete on public.scripts to authenticated;

grant update (section, scene_title, estimated_duration_seconds, spoken_text, visual_direction, camera_direction, on_screen_text,
              audio_direction, transition, creative_purpose, is_locked) on public.script_scenes to authenticated;

grant insert (workspace_id, script_id, script_version, agent_run_id, report, checks, created_by) on public.script_quality_reports to authenticated;

grant insert (workspace_id, target_type, target_id, target_version, rating, reasons, comment, created_by) on public.script_feedback to authenticated;
grant delete on public.script_feedback to authenticated;

grant insert (workspace_id, kind, scope, statement, source, approved, created_by) on public.creative_preferences to authenticated;
grant delete on public.creative_preferences to authenticated;

-- History stays append-only for the service role too.
revoke update, delete, truncate on public.creative_rule_versions, public.script_versions, public.ai_agent_runs from service_role;

-- Config tables
create policy ai_agent_pricing_select on public.ai_agent_pricing for select to authenticated using (true);
create policy ai_usage_limits_select on public.ai_usage_limits for select to authenticated using (true);

-- Projects
create policy creative_projects_select on public.creative_projects for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy creative_projects_insert on public.creative_projects for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
create policy creative_projects_update on public.creative_projects for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy creative_projects_delete on public.creative_projects for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (created_by = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])));

-- Strategies
create policy content_strategies_select on public.content_strategies for select to authenticated
  using (public.is_workspace_member(workspace_id));
create policy content_strategies_insert on public.content_strategies for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
create policy content_strategies_update on public.content_strategies for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy content_strategies_delete on public.content_strategies for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (created_by = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])));

-- Rules: global library readable by everyone signed in; workspace rules by members.
create policy creative_rules_select on public.creative_rules for select to authenticated
  using ((workspace_id is null and (status in ('approved', 'disabled') or public.is_platform_admin()))
         or (workspace_id is not null and public.is_workspace_member(workspace_id)));
create policy creative_rules_insert on public.creative_rules for insert to authenticated
  with check (created_by = (select auth.uid()) and (
    (workspace_id is not null and public.is_workspace_member(workspace_id) and status in ('draft', 'pending_approval'))
    or (workspace_id is null and public.is_platform_admin())));
create policy creative_rules_update on public.creative_rules for update to authenticated
  using ((workspace_id is not null and public.is_workspace_member(workspace_id)) or (workspace_id is null and public.is_platform_admin()))
  with check ((workspace_id is not null and public.is_workspace_member(workspace_id)) or (workspace_id is null and public.is_platform_admin()));
create policy creative_rules_delete on public.creative_rules for delete to authenticated
  using (workspace_id is not null and public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

create policy creative_rule_tags_select on public.creative_rule_tags for select to authenticated
  using (exists (select 1 from public.creative_rules r where r.id = rule_id));
create policy creative_rule_tags_write on public.creative_rule_tags for insert to authenticated
  with check (exists (select 1 from public.creative_rules r where r.id = rule_id and (
    (r.workspace_id is not null and public.is_workspace_member(r.workspace_id)) or (r.workspace_id is null and public.is_platform_admin()))));
create policy creative_rule_tags_delete on public.creative_rule_tags for delete to authenticated
  using (exists (select 1 from public.creative_rules r where r.id = rule_id and (
    (r.workspace_id is not null and public.is_workspace_member(r.workspace_id)) or (r.workspace_id is null and public.is_platform_admin()))));

create policy creative_rule_versions_select on public.creative_rule_versions for select to authenticated
  using (exists (select 1 from public.creative_rules r where r.id = rule_id));
create policy creative_rule_overrides_select on public.creative_rule_overrides for select to authenticated
  using (public.is_workspace_member(workspace_id));

-- Runs: members see their workspace's runs.
create policy ai_agent_runs_select on public.ai_agent_runs for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- Generated content
create policy generated_ideas_select on public.generated_ideas for select to authenticated using (public.is_workspace_member(workspace_id));
create policy generated_ideas_insert on public.generated_ideas for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy generated_ideas_update on public.generated_ideas for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy generated_ideas_delete on public.generated_ideas for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy generated_hooks_select on public.generated_hooks for select to authenticated using (public.is_workspace_member(workspace_id));
create policy generated_hooks_insert on public.generated_hooks for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy generated_hooks_update on public.generated_hooks for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy generated_hooks_delete on public.generated_hooks for delete to authenticated using (public.is_workspace_member(workspace_id));

create policy scripts_select on public.scripts for select to authenticated using (public.is_workspace_member(workspace_id));
create policy scripts_insert on public.scripts for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
create policy scripts_update on public.scripts for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));
create policy scripts_delete on public.scripts for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (created_by = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])));

create policy script_scenes_select on public.script_scenes for select to authenticated using (public.is_workspace_member(workspace_id));
create policy script_scenes_update on public.script_scenes for update to authenticated
  using (public.is_workspace_member(workspace_id)) with check (public.is_workspace_member(workspace_id));

create policy script_versions_select on public.script_versions for select to authenticated using (public.is_workspace_member(workspace_id));

create policy script_quality_reports_select on public.script_quality_reports for select to authenticated using (public.is_workspace_member(workspace_id));
create policy script_quality_reports_insert on public.script_quality_reports for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));

create policy script_feedback_select on public.script_feedback for select to authenticated using (public.is_workspace_member(workspace_id));
create policy script_feedback_insert on public.script_feedback for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
create policy script_feedback_delete on public.script_feedback for delete to authenticated
  using (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));

create policy creative_preferences_select on public.creative_preferences for select to authenticated using (public.is_workspace_member(workspace_id));
create policy creative_preferences_insert on public.creative_preferences for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid())
              and (approved = false or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])));
create policy creative_preferences_delete on public.creative_preferences for delete to authenticated
  using (public.is_workspace_member(workspace_id)
         and (created_by = (select auth.uid()) or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])));
