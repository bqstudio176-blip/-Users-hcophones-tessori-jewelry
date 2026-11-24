# Changelog

All notable changes to Content OS. Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
