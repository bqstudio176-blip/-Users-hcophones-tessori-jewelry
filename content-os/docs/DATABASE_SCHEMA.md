# Database Schema — Content OS (Phase 1)

> **Status: DRAFT, reconstructed during Phase 1. Not yet approved.** It documents migrations `supabase/migrations/20261124000100…0400`. The migrations are the source of truth.

## Migrations

| File | Contents |
|---|---|
| `…0100_core_schema.sql` | Enums, tables, constraints, indexes, `updated_at` triggers |
| `…0200_functions.sql` | Authorization helpers, RPCs, credit ledger, audit triggers, profile provisioning |
| `…0300_rls_and_grants.sql` | RLS enabled on all tables, privileges, policies |
| `…0400_seed_plans.sql` | Plan catalogue (reference data required by `create_workspace`) |

## Entity relationships

```
auth.users 1─1 profiles 1─* workspace_members *─1 workspaces 1─1 workspace_settings
                                                     │ 1─1 subscriptions *─1 plans
                                                     │ 1─1 usage_credits
                                                     │ 1─* usage_transactions   (append-only)
                                                     │ 1─1 social_accounts 1─1 social_account_credentials (secret)
                                                     │ 1─* workspace_invitations
                                                     └ 1─* audit_logs           (append-only)
```

## Tables

| Table | Key columns and constraints |
|---|---|
| `profiles` | `id` → `auth.users` (cascade); `email`; `full_name`; `avatar_url`; `preferences jsonb` (object); `is_platform_admin` (trigger-guarded) |
| `plans` | `id` text PK; `monthly_credits ≥ 0`; `max_members ≥ 1`; `price_cents`; `features jsonb` |
| `workspaces` | `name` (2–80 characters after trim); `slug` unique, matching `^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$`; `owner_id` → `profiles` (restrict) |
| `workspace_members` | PK (`workspace_id`, `user_id`); `role` enum; **partial unique index: one `owner` per workspace** |
| `workspace_invitations` | `token_hash` unique (SHA-256; the plaintext token is never stored); `role ≠ owner`; expires after 7 days; partial unique index on (`workspace_id`, lower(`email`)) for open invitations |
| `workspace_settings` | 1:1 with the workspace; `timezone`, `default_language`, `content_niche`, `brand_voice`, `target_audience` (length-checked) |
| `subscriptions` | **`workspace_id` unique**; `plan_id` → `plans`; `status` enum; period start/end (end > start); provider columns reserved for billing |
| `usage_credits` | PK `workspace_id`; `balance ≥ 0` |
| `usage_transactions` | `type` enum; `amount ≠ 0`, with its sign checked against the type; `balance_after ≥ 0`; unique (`workspace_id`, `idempotency_key`) |
| `social_accounts` | **`UNIQUE (workspace_id)` (`social_accounts_one_per_workspace`)**: one social connection per workspace; non-secret metadata only |
| `social_account_credentials` | PK `social_account_id` (cascade); `workspace_id` unique; `encrypted_access_token` (application ciphertext `v<k>:iv:tag:data`); `key_version` |
| `audit_logs` | Identity PK; `action` matches `^[a-z_]+\.[a-z_]+$`; `metadata jsonb` |

## Functions (RPCs)

All functions are `SECURITY DEFINER`, use `set search_path = ''`, and derive identity from `auth.uid()`.

| Function | Callable by | Behaviour |
|---|---|---|
| `create_workspace(name, slug)` | authenticated | Requires a verified email and allows at most 5 owned workspaces. In one transaction it creates the workspace, owner membership, settings, `free` subscription, credit account, initial grant and an audit event. |
| `create_workspace_invitation(ws, email, role)` | authenticated | Owner can invite admins or members; an admin can invite members only. Enforces the seat limit. Returns the token once. |
| `revoke_workspace_invitation(id)` | authenticated | Owner or admin of that workspace. |
| `accept_workspace_invitation(token)` | authenticated | Requires a verified email matching the invitation. One use, not expired or revoked. Returns the same generic error for every failure. |
| `update_member_role(ws, user, role)` | authenticated | Owner only. Cannot change the owner role or assign `owner`. |
| `remove_workspace_member(ws, user)` | authenticated | Owner removes anyone except the owner. An admin removes members only. Anyone except the owner can leave. |
| `disconnect_social_account(ws)` | authenticated | Owner or admin. Credentials are deleted by cascade. |
| `admin_adjust_credits(ws, amount, reason)` | authenticated | Platform admins only. Writes to the ledger and the audit log. |
| `apply_credit_transaction(…)` | **service_role only** | Locks the balance row with `FOR UPDATE`, checks idempotency, rejects overdrafts, and writes the ledger row and balance atomically. |
| `log_audit_event(…)` | **service_role only** | Internal. |
| `is_workspace_member`, `workspace_role_of`, `has_workspace_role`, `shares_workspace_with`, `is_platform_admin`, `workspace_seat_usage`, `workspace_seat_limit` | authenticated | Read-only helpers used by policies and the UI. |

## Triggers

- `on_auth_user_created`: creates the profile and writes `user.registered`. `on_auth_user_email_changed` syncs the email to the profile.
- Audit triggers on workspace rename, settings changes, social account insert or status change, and subscription plan or status change.
- `profiles_guard_admin_flag`: rejects changes to `is_platform_admin` from client roles.

## Invariants verified by tests

- The credit balance equals the sum of the ledger, including under 20 concurrent consumers (`tests/db/credits.test.ts`).
- The ledger and audit log cannot be updated or deleted, even by `service_role`.
- Only one social account and one credentials row can exist per workspace.
- Only one owner can exist per workspace.

---

# Phase 2 — Discover & Analyze

## Migrations

| File | Contents |
|---|---|
| `…0500_discover_schema.sql` | `discovery_sources` (seeded), `content_references`, `reference_tags`, `discovery_searches`, `discovery_results`, plus triggers that keep each row in the same workspace as its parent |
| `…0600_analyze_schema.sql` | `video_analyses`, `analysis_jobs`, `analysis_job_logs`, `transcripts`, `transcript_segments`, `detected_scenes`, `analysis_reports`, `ai_invocations`, plus the upload, request/cancel and worker queue functions |
| `…0700_phase2_rls_and_grants.sql` | RLS on all new tables, column grants, function privileges |
| `…0800_media_storage.sql` | Private `media` bucket (200 MB limit; MP4/MOV/WebM/JPEG) and storage policies. Skipped when no `storage` schema exists. |

No Phase 1 table was duplicated. Analyses reuse the Phase 1 credit ledger (`apply_credit_transaction`) and audit log.

## Tables

| Table | Key columns and constraints |
|---|---|
| `content_references` | `source_type` (upload/instagram/youtube/web); `url` (https only); `normalized_url`; `title`, `description`, `notes`, `category`; server-managed `media_*`, `thumbnail_path`, `url_check`, `analysis_status`. **Duplicate detection:** unique per workspace on `normalized_url`, `media_sha256`, and (`provider`, `external_id`). |
| `reference_tags` | PK (`reference_id`, `tag`); tag matches `^[a-z0-9][a-z0-9 _-]{0,39}$`; must be in the same workspace as its reference |
| `discovery_searches` | Query, filters (jsonb), providers, saved flag and name, status (completed/partial/failed), per-provider errors |
| `discovery_results` | Provider, external id, URL, metadata, provider-reported `metrics`, `retrieved_at`, link to a saved reference; unique (`search_id`, `provider`, `external_id`) |
| `video_analyses` | Status (queued/processing/completed/failed/canceled), ffprobe `media_metadata`, `processing` facts, transcript and visual status, `credits_charged` / `credits_refunded`. **At most one active analysis per reference** (partial unique index). |
| `analysis_jobs` | Queue state: status, `current_step`, `steps` (jsonb), `attempts` / `max_attempts`, `run_after` (backoff), `locked_by`, `heartbeat_at`, `cancel_requested`, `idempotency_key` (unique per workspace) |
| `analysis_job_logs` | Append-only processing log |
| `transcripts`, `transcript_segments` | Provider, model, language; segments with original `start_ms` / `end_ms`, speaker and confidence |
| `detected_scenes` | `start_ms`, `end_ms`, generated `duration_ms`, ffmpeg `detection_score`, `frame_path`, `visual_analyzed`, `visual` (validated jsonb), transcript excerpt, purpose, editing notes |
| `analysis_reports` | `sections` (validated jsonb, `schema_version` 1), `user_notes`, model provider and id, prompt versions, tokens, cost, processing time |
| `ai_invocations` | One row per model call: purpose, model, prompt version, status (succeeded/failed/invalid_output/refused), tokens, latency, cost. Append-only. |

## Functions

| Function | Caller | Behaviour |
|---|---|---|
| `begin_reference_upload(ref, mime, size)` | member | Validates type and size, reserves `<ws>/references/<ref>/<uuid>.<ext>` |
| `complete_reference_upload(ref, sha256)` | member | Requires the storage object to exist; records its real size; duplicate hash → `23505` |
| `request_analysis(ref, idempotency_key)` | member | Requires an uploaded video and no active analysis; charges `analysis_credit_cost()` (5) atomically; queues the job; idempotent |
| `cancel_analysis(id)` | requester or owner/admin | Queued → cancelled and refunded immediately. Running → sets the cancel flag, which the worker checks between steps. |
| `claim_analysis_job(worker)` | service_role | `FOR UPDATE SKIP LOCKED`; also reclaims jobs whose heartbeat is older than 10 minutes |
| `heartbeat_analysis_job`, `finish_analysis_job`, `fail_analysis_job`, `cancel_running_analysis_job` | service_role | Only the worker holding the lock can call these. Failures are retried with backoff until `max_attempts`, then fail and refund once. |

## Deletion rules

- References cannot be deleted while an analysis is queued or running (enforced by RLS).
- Deleting a reference cascades to its tags, analyses, jobs, logs, transcripts, scenes and reports.
- Storage objects can be deleted by members only once orphaned: their reference or analysis row must be gone. The app removes them right after deleting the row.

---

# Phase 3 — Script Lab & Creative Intelligence

Migrations:
- `20261126000900_creative_schema.sql`: enums, tables, triggers
- `20261126001000_creative_functions_rls.sql`: functions, RLS, grants
- `20261126001100_seed_creative_rules.sql`: generated; 110 global rules, 231 tags

## Enums

`creative_rule_category` (10), `creative_rule_status` (draft, pending_approval, approved, disabled), `creative_evidence_type` (established_principle, practitioner_heuristic, experimental), `creative_complexity`, `creative_agent` (research, strategy, hook, script, script_edit, quality), `hook_category` (10), `script_format` (10).

## Tables

| Table | Purpose / key columns |
|---|---|
| `ai_agent_pricing` | Credits per agent: research 1, strategy 2, hook 2, script 4, script_edit 1, quality 1. Read-only to clients. |
| `ai_usage_limits` | Per plan: per-user per-minute, workspace hourly and daily limits (free 5/20/60, creator 8/60/300, studio 12/150/1000) |
| `creative_projects` | Workspace project: name, description, status (active/archived) |
| `content_strategies` | Strategy Builder fields (name, niche, target_audience, objective, main_topic, tone, platform, preferred_format, duration_seconds, reference_ids, manual_topics, restrictions, desired_cta, use_content_history), plus `research_brief`, `recommendations` (including rule reasons) and `selected_rule_ids`. A scope trigger checks that the project and every reference belong to the workspace. |
| `creative_rules` | Global (`workspace_id` null) or workspace rules. Full rule structure (see CREATIVE_RULES_DOCUMENTATION.md), `version`, `status`, approval fields. The versioning trigger snapshots the previous content on edit, bumps the version and resets workspace approval. |
| `creative_rule_tags` | (rule_id, tag) |
| `creative_rule_versions` | Append-only snapshots (rule_id, version, snapshot, changed_by) |
| `creative_rule_overrides` | Per-workspace enable/disable of global rules |
| `ai_agent_runs` | One row per agent run: agent, status (succeeded/failed/invalid_output/refused/rejected), provider, model, prompt_version, tokens, duration, cost_usd, **credits_charged**, error, request_summary. Append-only. |
| `ai_invocations` (+`agent_run_id`) | The Phase 2 per-call records are reused as Phase 3 usage records, one per model call |
| `generated_ideas` | Strategy output: kind (9), title, body, reasoning, `provenance` jsonb (observed/user/hypothesis with source), `is_favorite` |
| `generated_hooks` | text, `original_text` (kept when edited), category, mechanism, visual_opening, delivery, duration_seconds, rationale, rule_ids, is_favorite |
| `scripts` | project, strategy, hook, format, title, tone, target_duration_seconds, `sections` jsonb (8 sections plus rules_applied and assumptions), rule_ids, status (draft/approved/archived), `current_version`, `pending_proposal` (AI edit awaiting confirmation), `parent_script_id` (alternatives), notes |
| `script_scenes` | position (unique per script, deferrable), section, scene_title, estimated_duration_seconds, spoken_text, visual/camera/on-screen/audio direction, transition, creative_purpose, `is_locked` |
| `script_versions` | Append-only snapshots with source (generated, manual_save, before_ai_edit, ai_edit_applied, before_restore, restored) and note |
| `script_quality_reports` | script_version, agent_run_id, `report` (AI, heuristic), `checks` (deterministic) |
| `script_feedback` | target_type (idea/hook/script/recommendation/quality_report/strategy), target_id, **target_version**, rating, reasons (fixed set), comment. A trigger checks that the target is in the workspace. |
| `creative_preferences` | kind (prefer/avoid), scope, statement, source (user/feedback_suggestion), **approved**. Only approved preferences reach the agents. |

Every tenant table has `workspace_id`, RLS and a scope trigger that rejects cross-workspace foreign keys.

## Functions (all `SECURITY DEFINER`, `search_path = ''`)

| Function | Caller | Behaviour |
|---|---|---|
| `check_ai_usage(ws, agent)` | member | Returns `{allowed, reason, credits, …}`. Checks balance ≥ price and the per-user minute, workspace hour and workspace day limits. |
| `record_ai_agent_run(...)` | member | Inserts the run and its invocations. Charges credits through `apply_credit_transaction` **only when status = succeeded**; raises `P0001` if the balance is insufficient. |
| `save_script_version(script, note)` | member | Manual snapshot |
| `replace_script_content(script, title, sections, scenes, source, note)` | member | Atomic replace with a version before and after. For `ai_edit_applied`, rejects changes to locked scenes and stale proposals. |
| `restore_script_version(script, version)` | member | Snapshots current content (`before_restore`) and restores |
| `reorder_script_scenes`, `insert_script_scene`, `delete_script_scene` | member | Position-safe scene operations; locked scenes cannot be deleted |
| `set_creative_rule_status(rule, status)` | member / owner-admin / platform admin | Submit (member); approve or disable (owner/admin); global rules (platform admin). Audited. |
| `set_creative_rule_override(ws, rule, enabled)` | owner/admin | Disable or enable a global rule for the workspace |
| `set_creative_preference_approval(pref, approved)` | owner/admin | Activate or pause a preference |

## Privileges

Clients get column-level `insert`/`update` grants only on user-editable columns. `credits_charged`, `version`, `status`, `approved_by` and `current_version` are written only by RPCs or triggers. `ai_agent_runs`, `script_versions` and `creative_rule_versions` reject update and delete even for `service_role`.

---

# Phase 4 — Video Studio

Migrations:
- `20261128001200_video_studio_schema.sql`: enums, tables, scope triggers
- `20261128001300_video_studio_functions_rls.sql`: functions, RLS, grants, storage policies, render feedback target

## Tables

| Table | Purpose / key columns |
|---|---|
| `media_storage_limits` | Per plan: `max_bytes` (free 2 GB, creator 25 GB, studio 150 GB) and `draft_renders_per_hour` (10) |
| `media_assets` | User-owned media: `kind` (video/image/audio), `origin` (upload/recording), `storage_path` (reserved), mime, size, sha256 (verified by the worker), `status` (pending_upload → processing → ready / failed), ffprobe `metadata`, duration, width/height (rotation-aware), `has_audio`, `thumbnail_path`, `proxy_path`, tags, **`rights_confirmed_by/at`** (required) |
| `video_projects` | `script_id`, `script_version` plus `script_snapshot`, title, `format` (vertical/square/portrait), fps 30, `status` (draft/ready/archived), **`timeline` jsonb** with optimistic **`timeline_version`**, `ready_render_id/at/by` |
| `video_project_assets` | (project, asset) links for the current timeline, maintained by the save RPCs. FK `restrict` blocks deleting media in use. |
| `video_timeline_versions` | Append-only snapshots: `source` (created, manual, render, before_restore, restored, script_update), note |
| `voiceover_takes` | project, asset, `scene_key` (null = whole script), `status` (pending, transcribing, completed, unavailable, failed), `transcript` ({text, words[start,end,text]}), `deviation` ({similarity, missing, extra}) |
| `video_renders` | `kind` (draft/final), `status`, exact `timeline` snapshot and `timeline_version`, `duration_seconds`, `output_path`, `srt_path`, measured `stats`, deterministic `checks`, `credits_charged`, `credits_refunded`. At most one active render per project. |
| `video_jobs` | Queue for `asset`, `voiceover` and `render` jobs. Same columns as `analysis_jobs`: steps, attempts, `run_after`, `locked_by`, heartbeat, cancel flag, idempotency key. |

## Functions (all `SECURITY DEFINER`, `search_path = ''`)

| Function | Caller | Behaviour |
|---|---|---|
| `video_limits()`, `render_credit_cost(kind, seconds)`, `video_timeline_duration(timeline)` | any | Single sources of truth for limits and pricing (final: 3 credits + 1 per started 30 s over 60 s; drafts 0) |
| `begin_media_upload(ws, kind, mime, size, title, rights, origin)` | member | Rights required; mime allow-list per kind; ≤ 1 GB; plan quota (serialised per workspace, `54000`); reserves `<ws>/assets/<id>/<uuid>.<ext>` |
| `complete_media_upload(asset, sha)` | member | Requires the storage object; queues an `asset` job |
| `create_video_project(script, title, format, timeline)` | member | Snapshots the script server-side; checks the timeline; version 1 |
| `save_video_timeline(project, timeline, expected_version, snapshot, note)` | member | `40001` on a stale version; structure and limits checked; asset ownership and readiness verified; links synced; `ready` → `draft` |
| `update_video_from_script(project, timeline, expected_version)` | member | Snapshot, save the merged timeline, re-snapshot the script |
| `restore_video_timeline(project, version_id)` | member | Snapshot current, then restore |
| `set_video_project_archived(project, bool)` | member | Archive or unarchive (clears ready) |
| `add_voiceover_take(project, asset, scene_key)` | member | Audio or video assets of the workspace only; queues a `voiceover` job |
| `request_render(project, kind, idempotency_key)` | member | Idempotent; one active render per project; draft rate limit; charges credits atomically (`P0001` rolls everything back); snapshots the timeline |
| `cancel_render(render)` | requester or owner/admin | Queued → canceled and refunded; running → cancel flag |
| `mark_video_ready(project, render)` | member | Requires a completed final render of the current timeline version with checks `pass`/`warn` |
| `claim_video_job`, `heartbeat_video_job`, `defer_video_job`, `finish_video_job`, `fail_video_job`, `cancel_running_video_job`, `refund_render_credits` | service_role | Worker lifecycle. Failures retry with backoff, then fail. Renders are refunded exactly once. `defer` re-queues without consuming an attempt. |

## Storage

The `media` bucket allows files up to 1 GB, plus image, audio and `text/plain` (SRT) types. Inserts are allowed only to a reserved path (reference or asset in `pending_upload`). Members can delete objects only once their reference, asset, analysis or render row is gone.

## Privileges

Clients can update only `media_assets.title/tags` and `video_projects.title`, and can delete assets, projects and takes subject to policies. Every other write goes through RPCs. `video_timeline_versions` rejects update and delete even for `service_role`. `script_feedback.target_type` gains `video_render`.
