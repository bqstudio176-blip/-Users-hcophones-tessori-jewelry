# Changelog

All notable changes to Content OS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] — 2026-11-28 — Phase 4: Video Studio

### Added
- **Database** (migrations 1200–1300): media assets with plan storage quotas and rights confirmation; video projects built from scripts (script snapshot) with an optimistic-concurrency timeline; asset links that block deleting media in use; append-only timeline versions; voiceover takes with word-level transcripts and script deviation; renders with measured stats and checks; a `video_jobs` queue for asset processing, transcription and rendering; RPCs, RLS, storage policies; feedback on renders.
- **Engine** (`src/server/video`): timeline schema and validation; script merge with diff; voiceover-to-scene alignment; captions from measured word timings, or estimated (and labelled); ASS generation with escaped user text; SRT export; pure ffmpeg render plan (fill/fit-blur, Ken Burns, crossfades, clip audio, voice, looping music with ducking, loudness normalisation, draft watermark); deterministic pre-publish checks; render pricing.
- **Worker:** Video Studio jobs alongside analyses (`WORKER_QUEUES`): magic-byte validation, ffprobe, proxies and thumbnails; Whisper transcription with word timestamps; draft and final renders with step progress, heartbeats during encodes, cancellation, retries and exactly-once refunds. The worker image gains libass fonts.
- **UI:** Video Studio dashboard (videos, storage, render credits, new video from script), media library (multi-file upload, filters, detail with preview, rename, tags, delete), editor (scene list, approximate live preview with safe-zone guides, scene inspector, voiceover, music and captions panels, versioned saves with conflict detection), voiceover recorder with teleprompter and take review, render and checks page (progress, cancel, downloads, mark ready, feedback), timeline versions and update from script. Navigation enabled; "Make video" in Script Lab; Videos tile on the dashboard; billing copy.
- **Tests:** 45 new (405 total), including real-ffmpeg renders measured for resolution, codecs and loudness.
- **Docs:** Phase 4 sections in the status, test report, schema, architecture, security and API documents; the approved scope with implementation notes in `docs/PHASE_4_VIDEO_STUDIO_PROPOSAL.md`.

### Fixed
- Documented `CREATIVE_EFFORT` default corrected to `medium` (the code default).

## [0.3.0] — 2026-11-27 — Phase 3: Script Lab & AI Creative Intelligence Engine

### Added
- **Database** (migrations 0900–1100): creative projects, content strategies, creative rules (global and workspace, versioned, approval workflow, tags, per-workspace overrides), AI agent runs and pricing, usage limits per plan, generated ideas and hooks, scripts with scenes, versions and pending AI proposals, quality reports, feedback (stored with content version) and creative preferences. RLS, scope triggers and append-only history throughout.
- **Creative Rules Engine:** 110 original documented rules in 10 categories (29 established principles with evidence notes, 78 practitioner heuristics, 3 experimental), seeded by a generated migration (`npm run rules:seed`), with a deterministic, explainable selection engine.
- **Creative Orchestrator and 5 agents** (Research, Strategy, Hook, Script and its edit mode, Quality) on Claude through the shared provider abstraction, with Zod structured outputs, semantic validators, one corrective retry, versioned prompts and workspace-scoped, relevance-filtered context.
- **Billing:** per-agent credit prices charged only on validated success (`record_ai_agent_run`); pre-flight credit and rate-limit checks (`check_ai_usage`); usage and cost per run.
- **Safety:** untrusted-data delimiting and neutralisation, citation validation, forbidden-claim checks (no virality or result promises), 8-gram originality limit, locked scenes and stale-proposal protection in the database.
- **UI:** Script Lab dashboard, project page, Strategy Builder with provenance-labelled recommendations, Hook Generator, new-script form, Script Editor (scenes, sections, AI proposals, versions, alternatives), Version History, Quality Report, Creative Rules library, detail and editor, Feedback & preferences, and AI usage. "Send to Script Lab" from analysis reports; script count on the dashboard.
- **Tests:** 54 new (360 total).
- **Docs:** `docs/AI_ARCHITECTURE.md`, `docs/CREATIVE_RULES_DOCUMENTATION.md`; Phase 3 sections in the status, test report, schema and API integration documents.

## [0.2.0] — 2026-11-24 — Phase 2: Discover & Analyze

### Added
- **Database** (migrations 0500–0800): content references with duplicate detection (URL, provider item, file hash), tags, discovery sources, searches and results, video analyses, a Postgres job queue (`SKIP LOCKED` claims, heartbeats, retry with backoff, cancellation, idempotency), job logs, transcripts and segments, detected scenes, analysis reports, AI invocation records, and a private media bucket with path-reserved uploads. All workspace-scoped with RLS.
- **Discover:** dashboard with multi-source search and filters, saved searches, research history, recent and analyzed references, and trending (YouTube chart when configured). Search results show origin and retrieval date. Reference library with search, filters, sorting and pagination. URL import with accessibility checks (no video downloads). Direct-to-storage video upload. Reference detail page. A Sources page documenting each provider.
- **Discovery providers:** library, YouTube Data API v3, Instagram (connected account's media), and Instagram hashtag search (documented, unavailable), behind a pluggable `DiscoveryProvider` interface.
- **Analyze:** background worker (`npm run worker`, `worker/Dockerfile`) running ffprobe validation, audio extraction, ffmpeg scene detection, representative frames, Whisper transcription, Claude frame analysis, and separate hook, narrative, editing, summary and creative analyses with Zod-validated structured outputs, versioned prompts and server-side refusal fallbacks. Reports record provenance (model, prompt versions, tokens, cost, processing time).
- **Report UI:** live processing view; video preview with a scene timeline synced to the transcript; all report sections with observed facts separated from AI interpretations; notes, re-run, Markdown and JSON export; Script Lab hand-off marked as Phase 3.
- **Credits:** 5 per analysis, refunded on failure or cancellation.
- **Tests:** 121 new (306 total), including end-to-end pipeline tests with real ffmpeg and Postgres.
- **Docs:** `docs/API_INTEGRATIONS.md`; Phase 2 sections in the schema, architecture, security, status and test documents.

### Fixed
- Export file names broke on accented titles.

## [0.1.0] — 2026-11-24 — Phase 1: Foundation

### Added
- **Database** (Supabase Postgres, 4 migrations): profiles, workspaces, workspace members (owner/admin/member), invitations, workspace settings, plans, subscriptions, usage credits, append-only usage transactions, social accounts (one per workspace), isolated encrypted credentials, append-only audit logs.
- **Security**: RLS on every table; workspace-scoped policies; column-level update grants; `SECURITY DEFINER` RPCs with pinned `search_path`; platform-admin flag guarded by a trigger; ledger and audit log immutable even for `service_role`.
- **Authentication**: registration, login, logout, email verification (enforced in the database), password recovery, password change with re-authentication, sign out everywhere, session refresh in `proxy.ts`, open-redirect protection.
- **Workspaces**: atomic creation, switching, settings, invitation links (hashed, one use, email-bound, 7-day expiry), role management, member removal and leaving, plan seat limits.
- **Dashboard**: real workspace data (plan, credits, members, Instagram status, activity, usage), pending tasks derived from state, honest content-production placeholders.
- **Settings**: profile, workspace, members, connections, plan and usage (full ledger), security, preferences (dark/light/system theme).
- **Instagram foundation**: connection status model, signed and browser-bound OAuth state, code-to-long-lived-token exchange (unverified against live Meta), AES-256-GCM token vault with key rotation, disconnect.
- **Admin panel**: platform overview, workspaces (with credit adjustment), users, system activity. Returns 404 to non-admins.
- **UI system**: centralised design tokens, reusable accessible components, responsive sidebar with mobile drawer, loading, empty and error states, "Coming soon" modules (Discover, Analyze, Script Lab, Video Studio, Experiments, Publish, Analytics).
- **Tests**: 185 automated tests (91 against real PostgreSQL covering RLS, tenancy, roles, social uniqueness and ledger integrity; 94 unit tests).
- **Ops**: `.env.example`, Supabase CLI config, CI workflow, health endpoint, security headers.
- **Docs**: README, implementation status, test report, draft product, architecture, schema and security docs.

### Fixed
- Settings audit trigger crashed every settings update (`malformed array literal`). Caught by tests before release.
