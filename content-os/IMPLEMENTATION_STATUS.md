# Implementation Status — Phase 1: Foundation

_Last updated: 2026-11-24 · Branch: `claude/content-os-phase-1-xyfdxl`_

Legend: ✅ implemented and covered by automated tests · 🟡 implemented, but some or all of it needs a live Supabase/Meta environment to verify · ⛔ not implemented

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Users can register and authenticate | 🟡 | Sign-up, login, logout, verification, recovery and session refresh are implemented with `@supabase/ssr`. Profile provisioning, the verified-email requirement, route protection and validation are tested. **The Supabase Auth API calls themselves were not run against a live project** (none available). |
| 2 | Users can create workspaces | ✅ | `create_workspace` RPC; `tests/db/workspaces.test.ts` (9 tests) |
| 3 | Workspace data is properly isolated | ✅ | RLS on every table; `tests/db/rls-isolation.test.ts` (27 tests) |
| 4 | Roles and permissions work | ✅ | `tests/db/roles.test.ts` (19), `tests/unit/permissions.test.ts` (10), `tests/unit/guards.test.ts` (9) |
| 5 | Dashboard loads real database information | 🟡 | The dashboard queries real tables through RLS (plan, credits, members, social status, audit, computed tasks). The queries are type-checked, but they **have not run through PostgREST** against a live project. |
| 6 | Settings are functional | 🟡 | Profile, workspace, members, connections, plan and usage, security and preferences are wired to server actions. The database side is tested. The UI has not been run end to end against Supabase. |
| 7 | Usage transactions are recorded | ✅ | Append-only ledger plus `apply_credit_transaction`; initial grant on workspace creation; admin adjustments. `tests/db/credits.test.ts` (12) |
| 8 | Social connection foundation exists | ✅ / 🟡 | Schema, one-per-workspace constraint, credential isolation, encryption, OAuth state and disconnect are all tested. **The live Meta OAuth exchange is unverified.** |
| 9 | Admin routes are protected | ✅ | Proxy redirect, `requirePlatformAdmin` (404) and RLS. Tests in `tests/unit/proxy.test.ts`, `tests/unit/guards.test.ts` and `tests/db/platform-admin.test.ts`. |
| 10 | Critical automated tests pass | ✅ | 185/185 passing. See TEST_REPORT.md. |
| 11 | Deployable following documented instructions | 🟡 | README → Deployment. `next build` succeeds and `next start` serves pages with the expected redirects. The instructions have not been followed against a real Supabase project or hosting provider. |

**Bottom line:** the database, security model and application code are complete and tested where they could be. Phase 1 should only be declared accepted after running the [manual acceptance checklist](#manual-acceptance-checklist-required-before-sign-off) against a real Supabase project.

## Feature inventory

### A. Authentication
- ✅ Registration (`/register`) with server-side validation and no account enumeration
- ✅ Login and logout (`/login`, sidebar sign-out), with protection against open redirects
- ✅ Password recovery (`/forgot-password` → email → `/auth/confirm` → `/reset-password`)
- ✅ Email verification (`/verify-email`, resend; enforced in the app and in the database)
- ✅ Protected routes (proxy plus server guards)
- ✅ Session management (cookie refresh, sign out everywhere, password change with re-authentication)

### B. Multi-tenant workspace
- ✅ Creation (onboarding, plus "New workspace" in the switcher; up to 5 owned per user)
- ✅ Ownership (one owner per workspace, enforced by a database index)
- ✅ Settings (name, timezone, language, niche, brand voice, audience)
- ✅ Membership: invite by link (hashed, one use, 7-day expiry, bound to the email), accept, revoke, change role, remove, leave, plan seat limits
- ✅ Owner, admin and member roles
- ✅ Workspace switching (cookie checked against memberships)

### C. Dashboard
- ✅ Workspace info, plan, credits, member and seat counts, Instagram status
- ✅ Activity overview (audit log; owners and admins only)
- ✅ Content production placeholders, honestly labelled "Coming soon" with no fake numbers
- ✅ Usage overview (consumed this period, balance, recent transactions)
- ✅ Pending tasks computed from real state

### D. Account settings
- ✅ Profile · ✅ Workspace configuration · ✅ Security (password, sessions) · ✅ Preferences (theme dark/light/system; email preferences are stored but nothing sends email yet)

### E. Social connections foundation
- ✅ Instagram connection UI (connect, status, disconnect, error states)
- ✅ Connection status model (`pending`, `connected`, `expired`, `revoked`, `error`)
- ✅ Secure credential storage (separate table with no client access, AES-256-GCM with additional authenticated data, versioned keys)
- ✅ One connection per workspace (database unique constraint)
- 🟡 OAuth exchange against Meta's endpoints (implemented, unverified live)
- ⛔ Publishing (out of scope by design) · ⛔ Token refresh job (Phase 2)

### F. SaaS foundation
- ✅ Subscription model (one per workspace) and plan catalogue
- ✅ Usage credit balance plus append-only, idempotent, concurrency-safe ledger
- ✅ Admin visibility into plans, balances and the ledger
- ⛔ Payment provider and checkout (not in scope)

### G. Admin panel
- ✅ Restricted access (404 for non-admins; RLS-authorised reads)
- ✅ Workspace listing and detail with credit adjustment
- ✅ User listing · ✅ Subscription status · ✅ System activity

### UI
- ✅ Dark-first token system (`src/styles/tokens.css`), light and system themes
- ✅ Reusable components, responsive sidebar (mobile drawer), loading skeletons, empty, error and not-found states
- ✅ Accessibility: skip link, labelled controls, `aria-invalid` and `aria-describedby`, `aria-current`, focus rings, reduced motion
- ✅ Future modules in the navigation with a "Soon" badge and honest placeholder pages
- 🟡 Only the signed-out screens were visually checked (screenshots at desktop and 390px mobile width). Signed-in screens need a live backend to render.

## Architectural deviations (all documented in docs/SYSTEM_ARCHITECTURE.md §7)

1. **The approved architecture documents did not exist.** `CLAUDE.md`, `PRODUCT_SPEC.md`, `SYSTEM_ARCHITECTURE.md`, `DATABASE_SCHEMA.md` and `SECURITY_PLAN.md` were not in the repository, which contained only a built static jewelry website. The docs in `docs/` were reconstructed from the Phase 1 brief and the implementation, and **need approval**.
2. The app lives in `content-os/` so the existing static site is preserved.
3. Next.js 16, zod 4 and Vitest 5 instead of older majors, to clear published security advisories (`npm audit`: 0 vulnerabilities).
4. Invitations are delivered as one-time links rather than email, since no email provider was specified.
5. OAuth tokens are encrypted in the application rather than with Supabase Vault.
6. Platform admins read through RLS rather than the service-role key.

## Outstanding dependencies

| Dependency | Needed for | Owner |
|---|---|---|
| Supabase project (URL, anon key, service-role key) | Everything at runtime, plus live verification | Product/ops |
| Production SMTP provider | Verification and recovery emails at scale | Ops |
| Meta app (Instagram API with Instagram Login) with app review | Live Instagram connection | Product/ops |
| Hosting (for example Vercel) and a domain | Deployment | Ops |
| Approval of `docs/*` | Architecture sign-off | Product/tech lead |

## Manual acceptance checklist (required before sign-off)

Run these against a Supabase project after deployment:

1. Register → receive the email → click the link → land on `/onboarding`.
2. Create a workspace → the dashboard shows the Free plan, 50 credits, 1 member, and Instagram not connected.
3. Log out, then log in. Use "Forgot password" and complete the reset.
4. Invite a second account as a member → accept from that account → the member cannot edit settings and cannot see the audit log.
5. Owner promotes the member to admin, then removes them. Check both changes appear in the activity log.
6. Create a second workspace with another account. Neither account can see the other's data. Try `/admin` as a non-admin and confirm it returns 404.
7. Grant `is_platform_admin` to one account → `/admin` lists workspaces and users → adjust credits → the ledger shows the adjustment.
8. Change preferences to the light theme and confirm it persists across reloads. Change the password. Use "Sign out everywhere".
9. *(If Meta is configured)* Connect Instagram → status shows "connected" → disconnect.

---

# Phase 2: Discover & Analyze

_Last updated: 2026-11-24 · Branch: `claude/content-os-phase-1-xyfdxl` (session rules allow only this branch, so Phase 2 commits also land in PR #1)._

**Pre-development validation.** Phase 1 had no known defects. Its open item was live verification against Supabase, which is carried forward below. Phase 2 reuses the Phase 1 auth, workspaces, RLS helpers, credit ledger, audit log, token vault and UI system; nothing was rebuilt.

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Users can manually import references | ✅ / 🟡 | URL import (parsing, duplicate detection, accessibility check, tags, notes) and RLS are tested. The UI flow has not run against live Supabase. |
| 2 | Users can upload supported video files | ✅ / 🟡 | Path reservation, storage policies, size and type checks, magic bytes and duplicate hashes are tested in the database and unit suites. The direct browser upload to Supabase Storage is not live-verified. |
| 3 | Users can organize references | ✅ | Categories, tags, notes, edit, delete (blocked while analyzing), library search, filters, sort and pagination. `references.test.ts`, `discovery-providers.test.ts` |
| 4 | Discovery search works | ✅ / 🟡 | The library provider queries real data. Multi-provider runs isolate failures; searches and results are stored with origin and retrieval date; searches can be saved. YouTube and Instagram were tested against mocked HTTP only. |
| 5 | Automated discovery integrations documented and functional where credentials exist | 🟡 | Provider interface plus 4 providers, each documented (`docs/API_INTEGRATIONS.md`, Sources page). No YouTube or Meta credentials were available, so none is live-verified. Hashtag search is documented and correctly reported as unavailable. |
| 6 | Videos are processed asynchronously | ✅ | Postgres job queue plus a separate worker process. Pipeline integration tests and a real `npm run worker` smoke test (see TEST_REPORT.md) |
| 7 | Audio transcription works | 🟡 | Audio extraction is real (ffmpeg). The Whisper client is tested with mocked HTTP, and transcript persistence and alignment are tested. **No live Whisper call**; the credential request was not completed. |
| 8 | Scene detection works | ✅ | Real ffmpeg scene detection on fixture video finds cuts at about 2s and 4s; frames are extracted and stored; boundaries are merged and capped. `pipeline.test.ts`, `analysis-modules.test.ts` |
| 9 | AI analysis generates structured reports | 🟡 | Separate versioned prompts, Zod schemas, re-validation, timestamp checks, retry on invalid output and report persistence are all tested, with **mocked** Claude. **No live Claude call**: Anthropic keys can only be added as an environment variable (see Outstanding dependencies). |
| 10 | Users can inspect timestamps and scenes | ✅ / 🟡 | Report page with video preview, proportional timeline, clickable scenes and transcript lines (they seek the video), and scene details. Builds and typechecks; not rendered against live data. |
| 11 | Analysis results persist correctly | ✅ | Transcripts, segments, scenes, reports, AI invocations and job logs persist. Retries rewrite rows instead of duplicating them. `pipeline.test.ts` |
| 12 | Workspace isolation verified | ✅ | `references.test.ts` and `analysis-jobs.test.ts`: RLS on reads and writes, cross-workspace tag and result injection, storage paths, worker-only functions |
| 13 | Background job errors handled | ✅ | Permanent vs retryable errors, backoff, max attempts, crash recovery via heartbeat, cancellation, refunds exactly once |
| 14 | Automated tests pass | ✅ | 306/306 (121 new in Phase 2) |
| 15 | No critical or high-severity security issues open | ✅ | `docs/SECURITY_PLAN.md` §9. Remaining risks are medium or low, plus the live-verification gap. |

**Bottom line:** every Phase 2 module is implemented, and everything that could run here was exercised against real ffmpeg and Postgres. Criteria 7 and 9 (live transcription and live Claude analysis), and the live Supabase, YouTube and Instagram behaviour, still need credentials and the checklist below before Phase 2 can be accepted.

## Features implemented

- **Discover dashboard:**
  - search bar with filters (keywords, topic, niche, industry, format, category, sources) and per-source availability
  - recently added and recently analyzed references
  - saved searches and research history
  - trending, shown only when the YouTube API is configured
  - performance indicators: provider-reported counts only
- **Search results:** grouped by origin, with retrieval date, per-provider error or unavailable notices, "Save to library", and saving the search.
- **Manual import:** Instagram Reel/post and YouTube URL validation plus accessibility check; any other https link stored without fetching; MP4/MOV/WebM upload; title, description, category, tags and notes.
- **Reference library:** thumbnail, title, source, URL, author, duration, category, tags, import date, analysis status and notes, with search, filters, sorting, pagination, save, remove and duplicate detection.
- **Analysis pipeline:**
  - input validation and ffprobe metadata
  - audio extraction
  - ffmpeg scene detection and representative frames
  - Whisper transcription
  - Claude vision on frames
  - separate hook, narrative (storytelling, retention, CTA), editing, summary and creative prompts
  - validated report with provenance
- **Report screen:** video preview, metadata, transcript with timestamps, scene breakdown and timeline, the hook, storytelling, retention, CTA, editing and creative sections, and facts visibly separated from AI interpretation. Actions: notes, re-run, Markdown and JSON export, open in Discover. "Send to Script Lab" is shown disabled and marked Phase 3.
- **Jobs:** real step-by-step progress (no invented percentages), logs, cancel, retries, idempotency, credits charged and refunded.

## Not implemented (by design or blocked)

- Downloading videos from Instagram or YouTube URLs: not permitted, so the user uploads the file instead.
- Instagram hashtag search: needs Facebook Login for Business and Meta App Review.
- Speaker diarization: not supported by `whisper-1`.
- Upload progress percentage: supabase-js reports no byte progress, so the UI shows the phase instead.
- Per-workspace search rate limits, Instagram token refresh, and a resumable upload protocol for large files.

## Outstanding dependencies (Phase 2)

| Dependency | Needed for | How |
|---|---|---|
| `ANTHROPIC_API_KEY` | Analyses to complete (criterion 9) | Worker environment variable. In this cloud environment it can only be added as an environment variable in the environment settings (network secrets can't hold Anthropic keys), and a new session picks it up. |
| `OPENAI_API_KEY` | Transcripts (criterion 7) | Worker environment variable, or a network secret for `api.openai.com` in this environment |
| `YOUTUBE_API_KEY` | YouTube discovery and trending | Google Cloud project with YouTube Data API v3 enabled |
| Meta app (from Phase 1) | Instagram connection and own-media discovery | See README |
| Supabase project plus the worker deployed with ffmpeg | Everything at runtime | README → Deployment → Worker |

## Phase 2 manual acceptance checklist

1. Import an Instagram Reel URL and a YouTube URL. Check the accessibility status, the duplicate warning on a second import, and the tags and notes.
2. Upload an MP4 of 30–90 seconds. The library shows it; the thumbnail appears after analysis.
3. Run an analysis. Watch the steps advance, check that 5 credits were charged, then open the report: scenes match the visible cuts, the transcript matches the speech, and clicking a scene seeks the video.
4. Export Markdown and JSON. Edit the notes. Re-run the analysis.
5. Cancel a queued analysis and confirm the credits are refunded. Upload a renamed non-video file and confirm the analysis fails clearly with a refund.
6. With YouTube configured, run a search, save a result to the library, save the search, and check Trending on the Discover page.
7. From a second workspace, confirm none of the above is visible and that `/analyze/<id>` from the first workspace returns 404.

---

# Phase 3: Script Lab & AI Creative Intelligence Engine

_Last updated: 2026-11-27 · Branch: `claude/content-os-phase-1-xyfdxl`_

## Blocker carried over from Phase 2

Phase 2 acceptance criteria 7 (live transcription) and 9 (live AI analysis) remain **unverified against live providers**: no OpenAI or Anthropic key is available in the build environment. Phase 3 was built on the stable Phase 2 code (306 tests green), and every Phase 3 AI flow is tested end to end with a deterministic mock model against real Postgres. **Before sign-off, run the manual checklist below with real keys.**

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Projects and saved strategies with every Strategy Builder field | ✅ | `content_strategies`; `tests/db/creative.test.ts` |
| 2 | Recommendations with reasoning and provenance; no fabricated research | ✅ / 🟡 | Provenance mapped to real reference ids; unknown citations rejected and re-asked. Orchestrator tests. Live model unverified. |
| 3 | 100–120 documented rules in 10 categories with full structure | ✅ | 110 rules; integrity tests; CREATIVE_RULES_DOCUMENTATION.md |
| 4 | Rule library management (search, filters, tags, create/edit, enable/disable, versions, approval) | ✅ | RPCs plus versioning trigger tested; `/script-lab/rules` UI |
| 5 | Explainable rule selection, never every rule | ✅ | `selection.ts`; 5 unit tests; reasons stored on the strategy |
| 6 | Hook Generator: 10 approaches with full fields; generate more, compare, favorite, edit, send to Script Lab | ✅ / 🟡 | Mock end to end; no virality promises (validator) |
| 7 | Script Lab: 10 formats, 8 sections, scene-level fields, duration validated as an estimate | ✅ / 🟡 | Duration checks (±15%, min ±3s); UI labels estimates |
| 8 | Editor: edit, reorder, add, delete, duplicate, regenerate section, rewrite, tone, shorten/expand, versions, notes; user edits preserved | ✅ | Scene RPCs; proposal → confirm flow; locked scenes enforced in the RPC; stale proposals rejected |
| 9 | Quality Agent: 10 criteria, heuristic, recommends only | ✅ / 🟡 | Test asserts the script is unchanged after a report |
| 10 | 5 agents plus orchestrator; Claude behind a provider abstraction; schema-validated JSON | ✅ / 🟡 | `AnalysisModel`; Zod structured outputs; validators |
| 11 | Workspace-scoped, relevance-filtered context | ✅ | Cross-workspace isolation test; scope triggers |
| 12 | Feedback with reasons stored with the version; controlled preference retrieval; no silent training | ✅ | `script_feedback.target_version`; only approved preferences reach prompts |
| 13 | Usage and cost tracking; credits; no charge on failure; limits and rate limiting | ✅ | `record_ai_agent_run`, `check_ai_usage`; 4 DB tests plus orchestrator tests |
| 14 | Security: injection protection, originality | ✅ | Untrusted blocks, neutralisation, no tools, claim and citation checks, 8-gram originality ≤ 15% |
| 15 | UI screens | ✅ | Dashboard, Strategy Builder, Rules Library, Rule Detail, Hook Generator, Script Lab (new), Script Editor, Version History, Quality Report, Feedback & preferences, AI usage. `next build` passes. Not exercised in a browser against live Supabase. |
| 16 | Tests and docs | ✅ | 360/360 passing; docs listed below |

## Features implemented

- **Creative intelligence:** projects (create, archive); Strategy Builder; Research → Strategy orchestration; 9 recommendation kinds with provenance badges (Observed · R1, From your brief, Hypothesis); favorites; feedback on every item.
- **Creative Rules Engine:** 110 original rules; library UI with search and 7 filters; detail with version history; workspace rules (draft → approval); per-workspace overrides of global rules; selection engine with reasons.
- **Hook Generator:** categories, count and instructions; full hook fields; inline edit (original kept); favorite; delete; compare grid; "Write script from this hook".
- **Script Lab:** generate from strategy, with an optional hook, format, duration and tone; 8 sections plus scenes; duration panel (estimate); scene editor (edit, reorder, duplicate, add, delete, lock); AI tools (rewrite selected, regenerate section, change tone, shorten, expand) as proposals with a side-by-side diff and Apply/Discard; save, restore and view versions; alternatives as separate scripts; notes; status (draft/approved/archived).
- **Quality Agent:** 10 criteria (1–5) with explanations, strengths, weaknesses and suggestions by scene, deterministic checks, report history, heuristic disclaimer.
- **Feedback & preferences:** feedback history; deterministic suggestions from repeated reasons (never auto-applied); preferences with owner/admin approval.
- **AI usage:** per-run table (agent, status, model, prompt version, tokens, time, credits), totals, provider cost and price list.
- **Integration:** "Send to Script Lab" from analysis reports; real script count on the dashboard; billing copy updated.

## Not implemented / limitations

- Performance insights: none, because no real performance data exists yet (Phase 5+ analytics). The UI states this.
- Agents run synchronously in server actions (`maxDuration = 300`), not on the worker queue. Acceptable for single-agent latency; very long scripts may approach host timeouts.
- Rule selection is keyword-based, not semantic.
- No live Claude verification (no key in this environment).

## Outstanding dependencies (Phase 3)

| Dependency | Needed for | Owner action |
|---|---|---|
| `ANTHROPIC_API_KEY` on the **web app** | All Script Lab AI actions | Add it as an environment variable in hosting (not as a network secret) |
| Apply migrations 0900–1100 | Script Lab | `supabase db push` |
| Live verification | Phase 2 criteria 7 and 9, plus Phase 3 AI flows | Run the checklist below |

## Phase 3 manual acceptance checklist

1. Apply migrations and confirm `select count(*) from creative_rules where workspace_id is null` returns 110.
2. Analyze a reference (Phase 2), then click **Send to Script Lab** → create a project → save a strategy with that reference selected.
3. **Generate recommendations.** Check that every kind is present, observed items cite R1 and point to the reference, and the selected rules show their reasons. Credits drop by 3 (1 + 2).
4. Generate 5 hooks across 3 categories; edit one, favorite one, and use it to write a 45s Reel script.
5. In the editor: lock scene 2, ask "Shorten script", review the proposal (scene 2 unchanged), apply, and confirm a new version exists.
6. Edit a scene manually, then try to apply an older proposal: it must be blocked as stale.
7. Run a quality check. Scores show 1–5, and the script is unchanged.
8. Submit "not useful · too long" feedback twice, then confirm the suggestion appears on the Feedback page; add it, approve it as owner, and regenerate.
9. Remove `ANTHROPIC_API_KEY`: AI actions show "not configured" and no credits move.
10. Check `/script-lab/usage`: runs, tokens and credits match the ledger.

---

# Phase 4: Video Studio

_Last updated: 2026-11-28 · Branch: `claude/content-os-phase-1-xyfdxl` · Scope: `docs/PHASE_4_VIDEO_STUDIO_PROPOSAL.md`, approved with decisions D1–D5 as recommended (no AI voice; final render 3 credits up to 60 s + 1 per extra 30 s, drafts free at 10/hour; quotas 2/25/150 GB with 1 GB and 10 min per asset; 3-minute maximum; renders on the existing worker, CPU only)._

## Acceptance criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | Upload own video, image and audio; probed, thumbnailed, proxied | ✅ / 🟡 | Real ffmpeg worker tests (video, image, audio, disguised file rejected); quota and rights tests. Browser → live Supabase Storage upload not exercised. |
| 2 | Project from a script with scenes pre-populated and the version snapshotted | ✅ | `create_video_project` test; `buildInitialTimeline` unit tests |
| 3 | Assign and trim media per scene, fit, transition, on-screen text, reorder | ✅ | Editor harness in Chromium (assign, edit, save); render tests with fill, fit-blur, Ken Burns, crossfade |
| 4 | Record or upload a voiceover; transcribed and compared with the script | ✅ / 🟡 | Worker test with mock transcriber (words + deviation); Whisper word-timestamp request unit test. Live Whisper and browser microphone not exercised. |
| 5 | Captions timed from the voiceover (or estimated and labelled), editable, burned in, SRT | ✅ | Unit tests (word timing, estimation, ASS escaping, SRT); render test burns captions and uploads SRT; harness generated measured captions |
| 6 | Music with automatic ducking | ✅ | Render plan unit test (`sidechaincompress`); real render with music + voice |
| 7 | Draft and final renders on the worker with progress, cancel, retry, correct credits | ✅ | Worker tests: draft, final, cancel (refund), failure (refund once); DB tests for pricing, idempotency, rollback, draft limit |
| 8 | Final output meets Reels specs, verified on the output | ✅ | Final render measured 1080×1920, H.264/AAC, 30 fps, ≈ −14 LUFS |
| 9 | Deterministic pre-publish checks; "ready" gated | ✅ | `evaluateChecks` unit tests; `mark_video_ready` DB test; end-to-end mark ready after a final render |
| 10 | Versioned, restorable timelines; renders record their version | ✅ | DB tests (restore, append-only, conflict `40001`, render snapshot) |
| 11 | Workspace isolation | ✅ | DB tests across all 7 tables and all RPCs; foreign assets rejected in timelines |
| 12 | Critical tests pass, including real ffmpeg renders | ✅ | 405/405 |

## Features implemented

- **Media library:** multi-file upload with rights confirmation, magic-byte checks, quota display, filters, detail with preview and technical metadata, rename, tags, "used in", and deletion blocked while in use.
- **Video projects:** from any non-archived script (approved first), three formats, rename, archive, delete (not while rendering), and "Update from script" with a reviewed diff that keeps media and user text edits.
- **Editor:** scene list (reorder, duplicate, split, delete, add), media picker with thumbnails, trim, fit and focal point, Ken Burns, clip audio, duration, crossfade, on-screen text (5 styles, 3 positions); voiceover panel (whole video or per scene, offset, volume, fit durations to measured words); music (start, volume, fades, ducking); captions (5 styles, 3 positions, burn-in, generate, edit, delete, SRT download); live preview from proxies with safe-zone guides; validation before saving; versioned saves with conflict detection; unsaved-changes guard.
- **Voiceover:** browser recording (MediaRecorder) with teleprompter for the whole script or a scene, upload alternative, takes with transcription status, % match and skipped/added words, apply to timeline, delete unused takes.
- **Render & checks:** free watermarked drafts and paid finals, step progress with auto-refresh, cancel, downloads (MP4, SRT), measured stats, check list, "Mark ready to publish", feedback per render.
- **Versions:** every create, save-as-version, render, restore and script update; restore with a prior snapshot.
- **Integration:** navigation enabled; "Make video" in Script Lab; Videos tile on the dashboard; billing copy; render credits in the ledger.

## Not implemented / limitations

- AI voice (TTS): out of scope by decision D1.
- No encoder percentage. Progress is shown per step.
- The preview is approximate (HTML overlays over proxies). Fonts, blur and timing in the final render can differ slightly; the UI says so.
- Fit-blur in the preview uses the thumbnail as the blurred background; the render blurs the actual clip.
- A single track: no free-form multi-track editing (out of scope).
- Publishing to Instagram is Phase 5.

## Outstanding dependencies (Phase 4)

| Dependency | Needed for | Owner action |
|---|---|---|
| Apply migrations 1200–1300 | Video Studio | `supabase db push` |
| Raise the Supabase Storage global upload limit to ≥ 1 GB | Large uploads | Supabase dashboard → Storage settings (the Free tier caps at 50 MB) |
| Redeploy the worker image (libass fonts) with enough CPU | Asset processing and renders | Build `worker/Dockerfile`; optionally a dedicated `WORKER_QUEUES=video` process |
| `OPENAI_API_KEY` on the worker | Measured caption timing | Optional; without it captions use estimated timing |
| Live verification | Criteria 1 and 4, plus Phase 2–3 items | Checklist below |

## Phase 4 manual acceptance checklist

1. Upload a phone clip (MOV, rotated), a PNG and an MP3. Each becomes "ready" with a thumbnail and preview; the rotated clip shows the correct orientation.
2. Try uploading a `.sh` renamed to `.mp4`: it is rejected (browser, or the worker if the browser check is bypassed).
3. Script Lab → script → **Make video** → create (9:16). The scenes and on-screen text match the script.
4. Assign media to every scene, add a crossfade, set focus points and text. Save. Open the same video in a second tab, change something, save in the first tab: a conflict is reported and nothing is overwritten.
5. Voiceover tab: record the whole script with the teleprompter. The take shows "Transcribed" with a % match. Use it in the timeline, then **Fit scene durations to the voice** and **Generate captions** (timing says "measured"). Save.
6. Add music with ducking. Render a **draft**: it costs no credits, is watermarked and 540×960, and the checks show "Final render: fail".
7. Render a **final**: credits drop by 3 for ≤ 60 s; output 1080×1920, ≈ −14 LUFS; download the MP4 and SRT. **Mark ready to publish**.
8. Edit the timeline and save: status returns to Draft and the old render can no longer be marked ready.
9. Start a final render and cancel it while running: it becomes Canceled and credits are refunded.
10. Edit the script in Script Lab: the video shows "script changed". Review **Update from script** and apply; media is kept.
11. As another workspace's user, open the video URL: not found.
