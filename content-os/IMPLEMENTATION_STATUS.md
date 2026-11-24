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
