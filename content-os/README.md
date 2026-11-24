# Content OS

A multi-tenant SaaS for short-form content teams.

- **Phase 1 (Foundation):** authentication, workspaces and roles, dashboard, settings, Instagram connection foundation, plans and credit ledger, admin panel.
- **Phase 2 (Discover & Analyze):** reference library, multi-source discovery, URL and video import, and a background AI video analysis engine (transcription, scene detection, structured reports).

> This directory is self-contained. The repository root also holds a separate, pre-existing static site (Tessori Jewelry), which is untouched.

| Doc | Purpose |
|---|---|
| [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) | What is done, what is not, acceptance criteria |
| [TEST_REPORT.md](TEST_REPORT.md) | Test inventory, results, what is *not* covered |
| [CHANGELOG.md](CHANGELOG.md) | Release notes |
| [docs/](docs/) | Product spec, architecture, database schema, security plan (drafts awaiting approval), [API integrations](docs/API_INTEGRATIONS.md) |

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS (token-based) · Supabase (Postgres + RLS, Auth, PostgREST) · zod · Vitest

## Local development

Prerequisites: Node ≥ 20.11, **ffmpeg/ffprobe** (for the analysis worker and its tests), a Supabase project (hosted, or local via the [Supabase CLI](https://supabase.com/docs/guides/cli)), and PostgreSQL 15+ server binaries for the DB test suite.

```bash
cd content-os
npm install
cp .env.example .env.local        # fill in Supabase URL + keys

# Option A — local Supabase (needs Docker)
npx supabase start                # applies supabase/migrations automatically
# use the printed API URL / anon key / service_role key in .env.local

# Option B — hosted project
npx supabase link --project-ref <ref>
npx supabase db push

npm run dev                       # http://localhost:3000
npm run worker                    # separate terminal: processes analysis jobs (needs DATABASE_URL + ffmpeg)
```

With local Supabase, confirmation emails go to Inbucket at http://localhost:54324.

## Tests

```bash
npm test            # unit + database suites (starts a throwaway Postgres on :54329)
npm run test:unit   # unit only (no database needed)
npm run test:db     # RLS / tenancy / ledger tests against real Postgres
npm run typecheck
```

The DB suite runs `scripts/local-db.sh`. It creates a temporary cluster from the local PostgreSQL binaries, applies a **test-only** Supabase shim (`tests/db/supabase-shim.sql`) and then every migration. To use an existing database instead, set `TEST_DATABASE_URL` and `SKIP_DB_RESET=1`.

## Deployment

### 1. Supabase

1. Create a project and note the URL, anon key and service-role key.
2. Apply migrations: `npx supabase link --project-ref <ref> && npx supabase db push`.
3. Under **Authentication → URL Configuration**, set:
   - **Site URL:** `https://<your-domain>`
   - **Redirect URLs:** `https://<your-domain>/auth/confirm` and `https://<your-domain>/auth/callback`
4. Under **Authentication → Providers → Email**, enable **Confirm email**, set the minimum password length to 10, and require lowercase, uppercase and digits.
5. Under **Authentication → SMTP**, configure a production SMTP provider. Supabase's built-in sender is heavily rate-limited and not for production.
6. *(Recommended)* Point the email templates at the SSR-friendly confirm route, for example the "Confirm signup" template: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email&next=/onboarding`. The recovery template is the same with `type=recovery&next=/reset-password`. The default `{{ .ConfirmationURL }}` links also work through the `code` exchange.
7. Grant the first platform admin in the SQL editor, after that person has signed up:
   ```sql
   update public.profiles set is_platform_admin = true where email = 'you@company.com';
   ```

### 2. Application (for example on Vercel)

1. Import the repository and set **Root Directory** to `content-os`.
2. Set the environment variables listed in [`.env.example`](.env.example). `NEXT_PUBLIC_SITE_URL` must be the public HTTPS URL.
3. Build command: `npm run build`. Start command: `npm start`. Node 20.11 or later.
4. Check `GET /api/health`. It should return `{"status":"ok","supabaseConfigured":true}`.

Any Node host works the same way (`npm ci && npm run build && npm start`).

### 3. Analysis worker (Phase 2)

The web app only queues analyses. A separate long-running worker processes them.

1. Build and run `worker/Dockerfile` (Node 22 + ffmpeg) on any container host: Fly.io, Render, Railway, ECS or Cloud Run jobs. **Don't** run it on a serverless function, because jobs take up to several minutes.
2. Set these on the worker:
   - `DATABASE_URL`: Supabase direct connection string, server-only
   - `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: for storage
   - `ANTHROPIC_API_KEY`: required for analyses to complete
   - optional: `OPENAI_API_KEY` for transcripts, and `ANALYSIS_MODEL` (default `claude-opus-5-5`)
3. Scale by running more worker processes; jobs are claimed safely in parallel. A stuck job is reclaimed after 10 minutes without a heartbeat.
4. Optional, on the web app: set `YOUTUBE_API_KEY` to enable YouTube search and trending.

Limits: MP4, MOV or WebM; at most 200 MB and 10 minutes; at most 40 scenes and 24 analyzed frames per video. Each analysis costs 5 workspace credits, refunded if it fails or is cancelled. See [docs/API_INTEGRATIONS.md](docs/API_INTEGRATIONS.md) for provider costs and quotas.

### 4. Instagram (optional)

1. Create a Meta app with **Instagram API with Instagram Login**.
2. Add the OAuth redirect URI `https://<your-domain>/api/connections/instagram/callback`.
3. Set `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`, `OAUTH_STATE_SECRET` (`openssl rand -base64 48`) and `TOKEN_ENCRYPTION_KEY_V1` (`openssl rand -base64 32`).
4. Until these are set, the Connections page shows Instagram as unavailable on this deployment and the Connect button is disabled.

> ⚠️ The Instagram flow follows Meta's documented endpoints but has **not** been verified against a live Meta app. Test it in a Meta development app before relying on it.

### Key rotation

To rotate the token encryption key, add `TOKEN_ENCRYPTION_KEY_V2`, set `TOKEN_ENCRYPTION_CURRENT_VERSION=2`, and keep V1 until every stored token has been re-encrypted or reconnected. Each ciphertext records the key version it was encrypted with.

## Project layout

```
content-os/
  supabase/migrations/   version-controlled schema, RLS, RPCs, seed plans
  src/proxy.ts           session refresh + route gate
  src/app/               routes: (auth), (app), admin, onboarding, invite, api, auth
  src/server/actions/    all mutations (validate → authorize → DB)
  src/lib/               auth/session guards, permissions, validation, crypto, integrations
  src/components/        ui/ primitives, app/ shell + forms
  src/styles/tokens.css  design tokens (dark default, light, system)
  src/server/discovery/  discovery providers (library, YouTube, Instagram) + registry
  src/server/analysis/   worker pipeline: ffmpeg, scenes, transcription, Claude, report
  worker/                worker entry point + Dockerfile
  tests/unit, tests/db   Vitest suites (tests/fixtures: generated videos, mock providers)
```
