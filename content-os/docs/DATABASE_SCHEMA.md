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
