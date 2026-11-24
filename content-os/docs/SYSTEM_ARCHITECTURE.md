# System Architecture — Content OS

> **Status: DRAFT, reconstructed during Phase 1. Not yet approved.**
> The Phase 1 brief says to follow an approved `SYSTEM_ARCHITECTURE.md`, but no such file existed in the repository. This document records the architecture that was actually built so it can be reviewed and approved, or corrected. Every choice made without an approved source is listed in [Decisions taken without an approved spec](#decisions-taken-without-an-approved-spec).

## 1. Overview

```
Browser ──HTTPS──▶ Next.js 16 (App Router, Node runtime)
                    │  proxy.ts           session refresh + coarse route gate
                    │  Server Components  read via user-scoped Supabase client (RLS)
                    │  Server Actions     validate (zod) → authorize → RPC/table write
                    │  Route Handlers     /auth/confirm, /api/connections/instagram/*
                    ▼
                  Supabase
                    ├─ Auth (GoTrue)      email+password, verification, recovery
                    ├─ PostgREST          every app query runs as `authenticated` → RLS
                    └─ Postgres           schema, RLS, SECURITY DEFINER RPCs, audit
                    ▲
   service_role ────┘  (server only; used ONLY to write encrypted social credentials)
```

## 2. Components

| Layer | Location | Responsibility |
|---|---|---|
| Proxy | `src/proxy.ts`, `src/lib/supabase/proxy.ts` | Refreshes the Supabase session cookie (`getClaims()`) and redirects anonymous users away from protected prefixes (`src/lib/auth/route-access.ts`). |
| Session and guards | `src/lib/auth/session.ts` | `getSessionUser` (calls `getUser()`, which checks the session with Supabase Auth), `requireVerifiedUser`, `getWorkspaceContext`, `requireWorkspacePermission`, `requirePlatformAdmin`. Memoised per request with `React.cache`. |
| Permissions | `src/lib/auth/permissions.ts` | Role → capability matrix that mirrors the database rules. Used to decide what the UI renders and as an early check in actions. |
| Server actions | `src/server/actions/*` | Every mutation. Validate → authorize → call the RPC/table as the user → map DB errors to safe messages. |
| Data access | `src/lib/supabase/server.ts` | Per-request client acting as the signed-in user. Default for all reads and writes. |
| Privileged access | `src/lib/supabase/admin.ts` | Service-role client behind `server-only`. One use: the Instagram OAuth callback, after authorization has been checked. |
| Integrations | `src/lib/integrations/instagram.ts`, `src/lib/crypto/token-vault.ts` | OAuth state signing and verification, code exchange, AES-256-GCM token encryption. |
| UI | `src/components/ui/*`, `src/components/app/*`, `src/styles/tokens.css` | Design tokens, accessible primitives and the app shell. |

## 3. Tenancy model

- **The workspace is the tenant boundary.** Every tenant-owned row has a `workspace_id`.
- Users belong to workspaces through `workspace_members` with role `owner`, `admin` or `member`.
- The **active workspace** is stored in an httpOnly cookie (`cos_ws`). On every request it is checked against the user's RLS-filtered memberships. A tampered cookie falls back to the user's first workspace and can never select a foreign tenant (tested in `tests/unit/guards.test.ts`).
- Isolation is enforced **in the database** by RLS, not in application code. Application checks only decide what to render and fail fast.

## 4. Request flows

**Read (e.g. dashboard).** `getWorkspaceContext()` resolves the user and workspace. Then the user-scoped Supabase client issues the queries, and RLS filters rows to that workspace.

**Write (e.g. invite member).**
1. The server action validates input with zod.
2. `requireWorkspacePermission("members.invite")` checks the role in the app.
3. The RPC `create_workspace_invitation` re-checks the role in the database, enforces the seat limit and writes the audit log.

**Instagram connect.**
1. `GET /api/connections/instagram/start` checks the role (owner/admin) and the one-per-workspace rule. It signs an HMAC state (workspace, user, nonce, expiry), sets the nonce in an httpOnly cookie, and redirects to Instagram.
2. The callback verifies the signature, expiry, browser nonce and same user, and re-checks the role through RLS.
3. It exchanges the code for a long-lived token and fetches the profile.
4. It encrypts the token (AES-256-GCM, with the workspace ID as additional authenticated data) and inserts `social_accounts` + `social_account_credentials` with the service role.

## 5. Technology choices

| Choice | Reason |
|---|---|
| Next.js 16.4 (App Router, Turbopack) | Server-first rendering keeps tokens and queries on the server. 16.x was chosen over 15.x because 15.5's bundled PostCSS has published advisories (`npm audit` is clean on 16.4.6). |
| Supabase (Postgres, Auth, PostgREST) | Required by the brief. RLS gives database-enforced tenancy. |
| `@supabase/ssr` 0.12 | Cookie-based sessions for SSR. |
| zod 4 | Server-side validation. v3 has a published memory-exhaustion advisory. |
| Tailwind 3.4 + CSS variables | Centralised tokens with light/dark themes and no runtime cost. |
| Vitest 5 + local Postgres | Fast unit tests plus real-database RLS tests. |

## 6. Deployment topology

- Any Node 20.11+ host: Vercel, Fly, Render, or a container.
- Supabase hosted project for the database and auth.
- Migrations are applied with the Supabase CLI (`supabase db push`).
- See README → Deployment.

## 7. Decisions taken without an approved spec

These need review. Each is easy to change at this stage.

1. **Separate `content-os/` directory.** The repository held an unrelated static site (Tessori Jewelry, built Astro output). To preserve existing functionality, Content OS lives in `content-os/` and the static site files are untouched.
2. **Next.js 16 instead of 15**, for the security advisories above. Next 16 renamed `middleware.ts` to `proxy.ts`.
3. **Invitation links without email delivery.** No transactional email provider was specified, so the invite link is shown once to the inviter to copy. Only a SHA-256 hash of the token is stored.
4. **Platform admin as a profile flag** (`profiles.is_platform_admin`). It can be set only by the service role or the database owner, and a trigger blocks clients from changing it.
5. **Application-layer token encryption** (AES-256-GCM, versioned keys in environment variables) instead of Supabase Vault/pgsodium. This keeps keys out of the database entirely and works the same locally and in production.
6. **Admin reads through RLS** (`is_platform_admin()` in policies) rather than the service-role key, which reduces how widely the service role is used.
7. **Plan catalogue** (`free` / `creator` / `studio`) with placeholder prices. Nothing is charged.

## 8. Phase 2 additions: Discover and Analyze

```
Browser ──upload (signed-in, RLS-checked)──▶ Supabase Storage (private "media" bucket)
   │
   └─▶ Next.js server actions ──request_analysis()──▶ analysis_jobs (Postgres queue)
                                                         │ claim (FOR UPDATE SKIP LOCKED)
                                                         ▼
                       Worker process (npm run worker, Node + ffmpeg, separate container)
                         validate → media → scenes → transcription → visual → analysis → report
                         ffprobe/ffmpeg     │            │               │          │
                                            ▼            ▼               ▼          ▼
                                      Storage frames   Whisper         Claude     Postgres
```

- **Background processing uses a Postgres-backed queue, not Redis/BullMQ.** The brief allowed Redis/BullMQ only "if already approved", and it isn't part of the approved architecture. `analysis_jobs` provides:
  - claiming with `SKIP LOCKED`, so concurrent workers are safe
  - heartbeats and recovery of jobs whose worker died
  - retries with exponential backoff (30s × 2ⁿ, at most 15 minutes, up to 3 attempts)
  - cancellation
  - idempotency keys
  - per-step progress and logs

  This avoids new infrastructure, keeps job state under RLS (members watch progress safely), and lets job transitions commit atomically with credit refunds. If volume ever needs it, the claim function can be swapped for BullMQ without changing the pipeline.
- **The worker is a separate process** (`worker/index.ts`, `worker/Dockerfile`). It connects with `DATABASE_URL` (owner role) and uses the service role only for Storage. The web app never runs ffmpeg.
- **Pipeline steps** (`src/server/analysis/pipeline.ts`) are idempotent. Each step deletes and rewrites its own rows inside a transaction, so a retry never duplicates data. The worker checks for cancellation between steps.
- **Providers sit behind interfaces:** `DiscoveryProvider`, `TranscriptionProvider` and `AnalysisModel`, plus `MediaStore` (Supabase or local directory). Each can be swapped without touching the pipeline. Tests use clearly labelled mock implementations.
- **Facts versus interpretation:** scene boundaries, durations, cut rate and speech coverage are measured by ffmpeg and alignment code. Claude only interprets and is told not to recompute them. Report schemas separate `evidence` / `observations` (timestamped facts) from `interpretation`.

### Phase 2 deviations

1. **Postgres queue instead of Redis/BullMQ** (above).
2. **No server-side video download from URLs.** Imported Instagram and YouTube links are checked for accessibility (HEAD / oEmbed) and enriched with metadata. Analysis requires the user to upload the file. This follows the brief's "do not promise unrestricted downloading", platform terms, and SSRF prevention.
3. **Whisper for transcription** (the brief's example); speaker diarization is not available from `whisper-1`.
4. **Uploads go straight from the browser to Storage**, using the signed-in user's client restricted by an RLS policy to the path reserved by `begin_reference_upload()`. The web server never proxies large files and never uses the service role for uploads.
