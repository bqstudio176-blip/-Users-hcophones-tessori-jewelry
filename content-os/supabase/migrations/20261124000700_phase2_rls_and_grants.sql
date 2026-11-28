-- =============================================================================
-- Content OS — Phase 2 — Migration 0700: RLS and privileges for Discover/Analyze
-- Same model as 0300: deny by default, workspace-scoped policies, column grants,
-- server-managed columns and all analysis output writable only by the worker.
-- =============================================================================

alter table public.discovery_sources   enable row level security;
alter table public.content_references  enable row level security;
alter table public.reference_tags      enable row level security;
alter table public.discovery_searches  enable row level security;
alter table public.discovery_results   enable row level security;
alter table public.video_analyses      enable row level security;
alter table public.analysis_jobs       enable row level security;
alter table public.analysis_job_logs   enable row level security;
alter table public.transcripts         enable row level security;
alter table public.transcript_segments enable row level security;
alter table public.detected_scenes     enable row level security;
alter table public.analysis_reports    enable row level security;
alter table public.ai_invocations      enable row level security;

-- Start from nothing on the new tables.
revoke all on
  public.discovery_sources, public.content_references, public.reference_tags,
  public.discovery_searches, public.discovery_results, public.video_analyses,
  public.analysis_jobs, public.analysis_job_logs, public.transcripts,
  public.transcript_segments, public.detected_scenes, public.analysis_reports,
  public.ai_invocations
from anon, authenticated;

revoke execute on function
  public.analysis_credit_cost(), public.sync_reference_analysis_status(uuid),
  public.refund_analysis_credits(uuid), public.begin_reference_upload(uuid, text, bigint),
  public.complete_reference_upload(uuid, text), public.request_analysis(uuid, text),
  public.cancel_analysis(uuid), public.claim_analysis_job(text, integer),
  public.heartbeat_analysis_job(uuid, text, text, jsonb), public.finish_analysis_job(uuid, text),
  public.fail_analysis_job(uuid, text, text, boolean, integer),
  public.cancel_running_analysis_job(uuid, text),
  public.reference_tags_check_workspace(), public.discovery_results_check_workspace()
from public, anon, authenticated;

-- Reads (rows filtered by RLS)
grant select on
  public.discovery_sources, public.content_references, public.reference_tags,
  public.discovery_searches, public.discovery_results, public.video_analyses,
  public.analysis_jobs, public.analysis_job_logs, public.transcripts,
  public.transcript_segments, public.detected_scenes, public.analysis_reports,
  public.ai_invocations
to authenticated;

-- References: users write descriptive fields only. media_*, analysis_status
-- and url verification are set by RPCs / the worker.
grant insert (workspace_id, source_type, provider, external_id, url, normalized_url, title,
              description, author_name, thumbnail_url, duration_seconds, category, notes,
              url_check, metrics, retrieved_at, created_by)
  on public.content_references to authenticated;
grant update (title, description, category, notes) on public.content_references to authenticated;
grant delete on public.content_references to authenticated;

grant insert, delete on public.reference_tags to authenticated;

grant insert (workspace_id, query, filters, providers, name, is_saved, result_count, status, errors, created_by)
  on public.discovery_searches to authenticated;
grant update (name, is_saved) on public.discovery_searches to authenticated;
grant delete on public.discovery_searches to authenticated;

grant insert (search_id, workspace_id, provider, external_id, url, title, description, author_name,
              thumbnail_url, published_at, duration_seconds, metrics, retrieved_at, position)
  on public.discovery_results to authenticated;
grant update (reference_id) on public.discovery_results to authenticated;

grant update (user_notes) on public.analysis_reports to authenticated;

grant execute on function
  public.analysis_credit_cost(),
  public.begin_reference_upload(uuid, text, bigint),
  public.complete_reference_upload(uuid, text),
  public.request_analysis(uuid, text),
  public.cancel_analysis(uuid)
to authenticated;

grant execute on function
  public.claim_analysis_job(text, integer),
  public.heartbeat_analysis_job(uuid, text, text, jsonb),
  public.finish_analysis_job(uuid, text),
  public.fail_analysis_job(uuid, text, text, boolean, integer),
  public.cancel_running_analysis_job(uuid, text),
  public.refund_analysis_credits(uuid),
  public.sync_reference_analysis_status(uuid)
to service_role;

-- Logs/ledgers stay append-only even for the service role.
revoke update, delete, truncate on public.analysis_job_logs, public.ai_invocations from service_role;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
create policy discovery_sources_select on public.discovery_sources
  for select to authenticated using (true);

-- content_references
create policy content_references_select on public.content_references
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

create policy content_references_insert on public.content_references
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));

create policy content_references_update on public.content_references
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Safe deletion: not while an analysis is queued or running.
create policy content_references_delete on public.content_references
  for delete to authenticated
  using (public.is_workspace_member(workspace_id) and analysis_status not in ('queued', 'processing'));

-- reference_tags
create policy reference_tags_select on public.reference_tags
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy reference_tags_insert on public.reference_tags
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy reference_tags_delete on public.reference_tags
  for delete to authenticated using (public.is_workspace_member(workspace_id));

-- discovery_searches
create policy discovery_searches_select on public.discovery_searches
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy discovery_searches_insert on public.discovery_searches
  for insert to authenticated
  with check (public.is_workspace_member(workspace_id) and created_by = (select auth.uid()));
create policy discovery_searches_update on public.discovery_searches
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy discovery_searches_delete on public.discovery_searches
  for delete to authenticated
  using (
    public.is_workspace_member(workspace_id)
    and (created_by = (select auth.uid())
         or public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
  );

-- discovery_results
create policy discovery_results_select on public.discovery_results
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy discovery_results_insert on public.discovery_results
  for insert to authenticated with check (public.is_workspace_member(workspace_id));
create policy discovery_results_update on public.discovery_results
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));

-- Analysis output: read-only for members (and platform admins).
create policy video_analyses_select on public.video_analyses
  for select to authenticated using (public.is_workspace_member(workspace_id) or public.is_platform_admin());
create policy analysis_jobs_select on public.analysis_jobs
  for select to authenticated using (public.is_workspace_member(workspace_id) or public.is_platform_admin());
create policy analysis_job_logs_select on public.analysis_job_logs
  for select to authenticated using (public.is_workspace_member(workspace_id) or public.is_platform_admin());
create policy transcripts_select on public.transcripts
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy transcript_segments_select on public.transcript_segments
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy detected_scenes_select on public.detected_scenes
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy analysis_reports_select on public.analysis_reports
  for select to authenticated using (public.is_workspace_member(workspace_id));
create policy analysis_reports_update_notes on public.analysis_reports
  for update to authenticated
  using (public.is_workspace_member(workspace_id))
  with check (public.is_workspace_member(workspace_id));
create policy ai_invocations_select on public.ai_invocations
  for select to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]) or public.is_platform_admin());
