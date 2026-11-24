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
4. **The CI workflow** (`.github/workflows/content-os-ci.yml`) and **`supabase/config.toml`** were written but not executed in GitHub Actions or with the Supabase CLI.
5. The DB tests use a **shim** for Supabase's `auth` schema and roles (`tests/db/supabase-shim.sql`). It reproduces how `auth.uid()` reads `request.jwt.claims`, the three API roles and Supabase's default grants, but it is not the real Supabase image.

## How to reproduce

```bash
cd content-os
npm ci
npm test                 # requires PostgreSQL server binaries (initdb/pg_ctl)
npm run typecheck
NEXT_PUBLIC_SUPABASE_URL=https://x.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=x npm run build
```
