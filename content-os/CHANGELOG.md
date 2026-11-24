# Changelog

All notable changes to Content OS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
