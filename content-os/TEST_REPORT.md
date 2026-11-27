# Test Report — Phase 1

_Run date: 2026-11-24 · Node 22.23 · PostgreSQL 16.15 (local throwaway cluster) · Vitest 5.1.1_

## Summary

| Check | Command | Result |
|---|---|---|
| Unit + DB tests | `npm test` | ✅ **185 passed, 0 failed** (15 files) |
| Type check | `npm run typecheck` | ✅ no errors |
| Production build | `npm run build` | ✅ compiled, all 33 routes |
| Dependency audit | `npm audit` | ✅ 0 vulnerabilities |
| Runtime smoke test | `next start` + curl | ✅ see below |

## Test inventory

### Database suite: real PostgreSQL, run as Supabase roles (`tests/db`, 91 tests)

Each "as user" query runs inside `SET LOCAL ROLE authenticated` with `request.jwt.claims` set, which is exactly how PostgREST runs requests. That means RLS, column grants and function privileges are what's under test, not mocks.

| File | Tests | Covers |
|---|---:|---|
| `auth-provisioning.test.ts` | 9 | Profile created on sign-up; email sync; self-update allowed; **no self-escalation to platform admin**; no email spoofing; no cross-user edits; anonymous access denied; **verified email required** |
| `workspaces.test.ts` | 9 | Atomic provisioning (member, settings, subscription, credits, ledger, audit); slug and name validation; duplicate slugs; rollback on failure; 5-workspace cap; no anonymous or direct inserts; rename allowed but slug and owner immutable |
| `rls-isolation.test.ts` | 27 | **Cross-tenant reads blocked on all 9 tenant tables** (plus checks that the owning tenant can see its own rows); profiles of non-colleagues hidden; credentials unreadable by every role; anon denied everywhere; helper functions leak nothing; **cross-tenant writes and RPCs blocked**; no direct writes to credits, ledger or subscriptions |
| `roles.test.ts` | 19 | Settings: owner and admin can edit, member cannot; invitations (member cannot invite, admin cannot invite admins, nobody can invite an owner, only a hash is stored, email-bound, one use, expiry and revocation, seat limit); role changes owner-only; owner cannot be removed; admin removes members but not admins; members can leave; single owner enforced by index; audit log visible to owner and admin only; clients cannot write audit rows |
| `social-accounts.test.ts` | 10 | **A second account for the same workspace fails with `23505` on `social_accounts_one_per_workspace`**; one credentials row per workspace; members read metadata but never credentials; no direct client writes; member cannot disconnect; admin disconnect cascades credentials; reconnect after disconnect works; status changes audited |
| `credits.test.ts` | 12 | Consume with `balance_after`; overdraft rejected with nothing written; idempotency replay; type and sign constraints; balance equals ledger sum; **20 concurrent consumers: exactly 10 succeed and the balance ends at 0**; ledger and audit log append-only even for `service_role`; clients cannot call the internal ledger function; admin adjustments limited to platform admins, with a reason required, ledgered and audited |
| `platform-admin.test.ts` | 5 | Platform admins read across tenants; regular users see nothing; `is_platform_admin()` correct; admins still cannot read credentials; admins cannot change tenant data through RLS |

### Unit suite (`tests/unit`, 94 tests)

| File | Tests | Covers |
|---|---:|---|
| `route-access.test.ts` | 38 | Every protected prefix redirects anonymous visitors to `/login?next=`; authenticated users allowed in; all `/admin/*` paths protected; look-alike paths not over-matched; guest-only pages; public callbacks; **open-redirect rejection** (`//evil`, `https://`, `/\`, control characters) |
| `proxy.test.ts` | 9 | Actual `proxy()` with a mocked Supabase client: anonymous `/admin`, `/admin/users`, `/admin/workspaces/:id`, `/dashboard`, `/settings/*` and `/api/connections/*` redirect; authenticated requests pass; query strings are not leaked |
| `guards.test.ts` | 9 | **`requirePlatformAdmin`**: anonymous → `/login`, unverified → `/verify-email`, non-admin owner → 404, admin passes; the admin server action rejects non-admins before any database call; **a tampered workspace cookie cannot select a foreign tenant**; Forbidden for insufficient roles; manager-only actions refuse members without a database call |
| `permissions.test.ts` | 10 | Role matrix, invitable roles, removal and role-change rules (these mirror the database) |
| `validation.test.ts` | 8 | Password policy, email normalisation, slug generation matches the database pattern, timezone and language validation, credit adjustment input, preference defaults |
| `token-vault.test.ts` | 6 | AES-256-GCM round trip, fresh IV each time, additional-data binding to the workspace, tamper detection, key rotation, fails closed on bad keys |
| `instagram.test.ts` | 9 | OAuth state: signature, browser binding, user binding, expiry, malformed input; authorize URL scope; code exchange against **mocked** HTTP; errors don't leak secrets |
| `tasks-and-errors.test.ts` | 5 | Pending tasks derived from real state; database error messages mapped to safe text |

## Runtime smoke test (production build, placeholder Supabase env)

```
/api/health          200   {"status":"ok","supabaseConfigured":true}
/login               200   (renders "Welcome back", data-theme="dark")
/register            200
/forgot-password     200
/verify-email        200
/invite/abc          200   (shows "malformed" state)
/dashboard           307 → /login?next=%2Fdashboard
/admin               307 → /login?next=%2Fadmin
/settings/members    307 → /login?next=%2Fsettings%2Fmembers
/                    307 → /login
Headers: X-Frame-Options DENY, nosniff, Referrer-Policy, HSTS; no X-Powered-By
```

Playwright screenshots were taken of `/register` (with server-side validation errors) and of `/login` at 390px width (no horizontal scroll).

## Defects found by the tests and fixed

| Defect | Found by | Fix |
|---|---|---|
| The settings audit trigger built its changed-fields array with `text[] \|\| 'literal'`, which Postgres parsed as an array literal and failed with `malformed array literal`, **breaking every settings update** | `roles.test.ts` | Switched to `array_append()` in migration 0200 |
| Input borders used Tailwind's default grey instead of the border token | Visual check | Token-based default border colour |

## Not covered (blockers and limitations)

These are stated plainly so they aren't mistaken for passing tests:

1. **Live Supabase Auth and PostgREST were not exercised.** No Supabase project or credentials were available, Docker isn't available here (so no `supabase start`), and downloading a standalone PostgREST binary to run the app's queries locally was blocked by this environment's permission policy. Therefore:
   - The `supabase.auth.*` calls (sign-up, sign-in, verify, reset, sign-out) are untested beyond types and mocks.
   - The PostgREST query shapes used by the pages (for example the embedded joins `workspace:workspaces!inner(...)`, `profile:profiles!workspace_members_user_id_fkey(...)` and `workspace_members(count)`) are type-checked but **not executed**.
   - **Mitigation:** the [manual acceptance checklist](IMPLEMENTATION_STATUS.md#manual-acceptance-checklist-required-before-sign-off) must be run against a real project.
2. **Instagram OAuth against Meta was not exercised.** It is tested only with mocked HTTP responses. Meta's response formats should be confirmed in a development app.
3. **No browser end-to-end tests of signed-in pages**, since they need a live backend. Recommended next: Playwright end-to-end tests against `supabase start` in CI.
4. **The CI workflow** (`.github/workflows/content-os-ci.yml`) has since run green on GitHub Actions (PR #1, all 185 tests including the DB suite). **`supabase/config.toml`** has not been run with the Supabase CLI.
5. The DB tests use a **shim** for Supabase's `auth` schema and roles (`tests/db/supabase-shim.sql`). It reproduces how `auth.uid()` reads `request.jwt.claims`, the three API roles and Supabase's default grants, but it is not the real Supabase image.

## How to reproduce

```bash
cd content-os
npm ci
npm test                 # requires PostgreSQL server binaries (initdb/pg_ctl)
npm run typecheck
NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x npm run build
```


---

# Phase 2 Test Report: Discover & Analyze

_Run date: 2026-11-24 · Node 22.23 · PostgreSQL 16.15 · ffmpeg 6.1.1 · Vitest 5.1.1 · `@anthropic-ai/sdk` 1.13.0_

## Summary

| Check | Result |
|---|---|
| `npm test` | ✅ **306 passed, 0 failed** (23 files; 121 new in Phase 2) |
| `npm run typecheck` | ✅ |
| `npm run build` | ✅ (includes `/discover/*`, `/analyze/*`, `/api/analyses/*`) |
| `npm audit` | ✅ 0 vulnerabilities |
| Real worker smoke test (`npm run worker`) | ✅ (below) |

## Real vs mocked

| Component | In tests |
|---|---|
| PostgreSQL schema, RLS, queue functions | **Real** (local cluster plus Supabase shim, including a minimal `storage` schema) |
| ffprobe / ffmpeg (metadata, audio extraction, scene detection, frames) | **Real**, on generated fixture videos |
| Media storage | Local-directory `MediaStore` (the Supabase Storage implementation is not exercised) |
| Claude | **Mocked** `AnalysisModel` in pipeline tests; the Claude provider class is tested with a **stubbed SDK client** |
| Whisper | **Mocked** `TranscriptionProvider` in pipeline tests; the Whisper client is tested with **mocked HTTP** |
| YouTube, Instagram, oEmbed | **Mocked HTTP** |

## New test files

| File | Tests | Covers |
|---|---:|---|
| `tests/db/references.test.ts` | 17 | Reference creation; server-managed columns locked; DB validation; **duplicate detection** by URL, provider item and file hash; tags, notes and delete; **workspace isolation** for references, searches and results, including cross-workspace injection; saved-search delete rules; **upload flow and storage policies** (reserved path only, outsiders blocked, type and size limits, object must exist, real size recorded, orphan-only deletion) |
| `tests/db/analysis-jobs.test.ts` | 17 | Credits charged on request; uploaded video required; one active analysis per reference; idempotency key; **insufficient credits roll back atomically**; outsiders cannot request, cancel or read; clients cannot call worker functions or write results; cancel (queued: immediate refund; running: flag); **SKIP LOCKED single claim with 5 concurrent workers**; finish; lock ownership; **retry with backoff then fail and refund**; permanent failure with a single refund; **heartbeat crash recovery**; no deletion during analysis; notes-only report edits |
| `tests/db/pipeline.test.ts` | 18 | **End-to-end pipeline with real ffmpeg:** steps recorded; ffprobe metadata; **scene cuts at about 2s and 4s with ffmpeg scores**; frames exist; **only one JPEG per scene sent to the vision model, none to text steps**; transcript timestamps preserved and aligned to scenes; schema-valid report with measured facts, tokens, cost and prompt versions; AI invocations recorded; reference thumbnail and duration; logs. No transcription provider → completes without a transcript. Silent video → `no_audio`. **Fake video (a shell script) rejected without being executed.** Duration limit. Missing AI provider fails with a refund. **Transient failure → retry → success with no duplicate rows.** Out-of-range timestamps re-asked; persistently invalid output → retry with nothing stored. **Cancellation between steps refunds credits with zero AI spend.** |
| `tests/unit/discover-url.test.ts` | 24 | Instagram and YouTube URL forms, canonicalisation, **SSRF rejections** (http, IPv4/IPv6 literals, metadata IP, localhost, `.internal`, credentials, ports, `file:`, `javascript:`), tracking-parameter stripping |
| `tests/unit/discover-upload.test.ts` | 6 | Type, extension and size validation; **magic-byte sniffing** rejects executables, images and scripts; tags; PostgREST-safe search terms |
| `tests/unit/discovery-providers.test.ts` | 15 | Every provider documented; **failure isolation**; YouTube search, enrichment and format filter, with absent metrics left absent; Instagram own-media filter; hashtag search unavailable; library filter, sort and pagination; untrusted parameter parsing; URL checks (HEAD only, no redirects, login wall, 404, network failure, oEmbed metadata, other sites never fetched) |
| `tests/unit/analysis-modules.test.ts` | 19 | Scene metadata parsing; boundaries, merge and cap; vision budget; ffprobe parsing; transcript alignment; measured editing facts; schema and timestamp validation; cost table; **Claude provider:** structured-output request with fallbacks and images, re-validation, refusal, truncation, SDK error mapping, fallbacks opt-out; **Whisper client:** request format, timestamp conversion, error classes |
| `tests/unit/report-export.test.ts` | 3 | Every section present, AI interpretations labelled, timestamps kept, Markdown table escaping, safe file names |
| `tests/unit/route-access.test.ts` | +2 | `/api/analyses` protected |

## Real worker smoke test

A job was queued against the local database, and `npm run worker` ran via `tsx` with no AI or transcription keys configured:

```
[worker] smoke-worker started · transcription: NOT CONFIGURED · AI: NOT CONFIGURED
info  validate       Validate input: done — MP4, 4.0s, 320x240
info  media          Process media: done — no audio stream
info  scenes         Detect scenes: done — 1 cut(s) detected → 2 scene(s)
info  transcription  Transcribe audio: skipped
error visual         AI analysis provider is not configured (ANTHROPIC_API_KEY)
analysis: failed · credits refunded (balance 45 → 50) · graceful shutdown on SIGTERM
```

## Defects found and fixed during Phase 2

| Defect | Found by | Fix |
|---|---|---|
| `thumbnail_path` used by the library query but missing from the schema | Code review while writing the library layer | Column added to migration 0500 before any deployment |
| Accented titles produced broken export file names (`Réference` → `re-ference`) | `report-export.test.ts` | Strip combining marks after NFKD normalization |
| Provider-docs test threshold rejected the valid value "Free." | `discovery-providers.test.ts` | Test corrected (the code was right) |

## Not covered (blockers)

1. **No live Claude, Whisper, YouTube or Instagram calls.** No credentials were available. Anthropic keys can't be stored as network secrets in this environment. An OpenAI network-secret request was opened but not completed before the session restarted.
2. **Supabase Storage, Auth and PostgREST not exercised live**, including the browser upload and the signed URLs. Same root cause as Phase 1.
3. **Signed-in Discover and Analyze pages not rendered in a browser**, since they need a live backend. They compile, typecheck and build.
4. **`worker/Dockerfile` not built**, because Docker isn't available in this environment.

---

# Phase 3 Test Report: Script Lab & Creative Intelligence

_Run date: 2026-11-27 · Node 22 · PostgreSQL 16 (local throwaway cluster) · Vitest 5.1.1_

## Summary

| Check | Command | Result |
|---|---|---|
| Unit + DB tests | `npm test` | ✅ **360 passed, 0 failed** (26 files; 54 new) |
| Type check | `npx tsc --noEmit` | ✅ no errors |
| Production build | `npm run build` | ✅ compiled; 11 new Script Lab routes |
| Dependency audit | `npm audit --omit=dev` | ✅ 0 vulnerabilities |

## Real vs mocked

| Real | Mocked |
|---|---|
| PostgreSQL with all migrations, RLS, grants, RPCs and triggers, run as the `authenticated` role through `pgCreativeDb` | The model: `MockCreativeModel` returns deterministic, schema-valid fixtures, and can be scripted to return invalid output, unknown citations, transcript copies, refusals or provider errors |
| The full orchestrator, validators, selection engine, credit ledger, usage records and versioning | — |

## New test files

| File | Tests | Covers |
|---|---:|---|
| `tests/db/creative.test.ts` | 17 | Project and strategy isolation; cross-workspace reference rejection; field validation; global library visibility and immutability; workspace rule drafting, approval and versioned re-approval; overrides; append-only history; **credits only on success**; `check_ai_usage` and the per-user rate limit; no free success without credits; usage isolation; script versioning and scene operations; reversible restore; **locked scenes protected from AI edits**; script isolation; feedback target checks; preference approval roles |
| `tests/db/creative-orchestrator.test.ts` | 16 | Research → Strategy with correct charges; provenance mapped to real reference ids; explained rule selection saved; **imported transcripts treated as untrusted (injection test)**; unknown citations re-asked once with both calls recorded; persistent invalid output never stored or charged; provider failures not charged; pre-flight stop on insufficient credits or missing configuration; **transcript reproduction refused**; hooks across categories with real rule ids; complete script within duration (v1); proposals preserve locked scenes and apply with versioning; locked-scene and stale proposals rejected; quality report leaves the script unchanged; alternatives leave the original intact; cross-workspace isolation |
| `tests/unit/creative-engine.test.ts` | 21 | Library integrity (110 rules, 11 × 10, unique, structure, seed in sync); selection (limited, diverse, explained, duration and tone filters, objective and format fit, signals, preferences, pins, exclusions, determinism); duration estimates and tolerance; sanitisation and delimiter forgery; injection detection; forbidden claims; 8-gram originality; relevance ranking; strategy, hook, script, edit and quality validators |

## Defects found and fixed during Phase 3

- A TypeScript `never` inference in `generateScript` (`typeof hook`). Fixed with an explicit `HookRow` type.
- Orchestrator tests tripped the real per-user rate limit (as designed). The tests now age earlier runs in `beforeEach`.
- The quality report UI initially showed scores out of 10 while the validator enforces 1–5. Fixed in the UI and docs.

## Not covered (blockers)

- **Live Claude calls** (no API key in this environment). Prompt quality, latency and real structured-output behaviour are unverified.
- **Browser end-to-end** against a live Supabase project: pages compile and their queries are type-checked, but they were not clicked through.
- Phase 2 criteria 7 and 9 remain unverified live (see IMPLEMENTATION_STATUS.md).
