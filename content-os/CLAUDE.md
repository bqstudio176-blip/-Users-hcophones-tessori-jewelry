# CLAUDE.md — Content OS

Guidance for AI agents and contributors working in `content-os/`.

## Ground rules
- The tenant boundary is the **workspace**. Every tenant table has `workspace_id`, RLS enabled, and policies using `is_workspace_member()` / `has_workspace_role()`.
- **Never rely on frontend authorization.** UI checks (`src/lib/auth/permissions.ts`) mirror the database. RLS and RPCs are authoritative. If you change a rule, change both, plus the tests.
- Multi-row writes go through `SECURITY DEFINER` RPCs with `set search_path = ''`. Identity comes from `auth.uid()`, never from an argument.
- Use `createClient()` from `src/lib/supabase/server.ts` (user-scoped). `createAdminClient()` (service role) is reserved for writing encrypted social credentials. Do not widen its use without a security review.
- Never expose tokens to the browser. Encrypt third-party tokens with `src/lib/crypto/token-vault.ts`.
- No fake functionality. Unbuilt modules stay `coming_soon` in `src/lib/navigation.ts`.
- Do not modify the static site files at the repository root.

## Conventions
- Next.js 16: `src/proxy.ts` (not `middleware.ts`); `params`, `searchParams` and `cookies()` are async. Route files may only export handlers. `"use server"` files may only export async functions.
- Mutations live in `src/server/actions/*` and follow validate (zod) → authorize → DB → map errors with `dbErrorMessage`.
- Styling: semantic Tailwind tokens only (`bg-surface`, `text-fg-muted`, `border-line`, `bg-accent`…). Tokens are defined in `src/styles/tokens.css`.
- New migrations: add a new timestamped file. Never edit an applied migration.

## Commands
```bash
npm test          # unit + DB (spins up local Postgres on :54329)
npm run typecheck
npm run build
```
Every schema or policy change needs a DB test in `tests/db/` that runs queries through `asUser`, `asAnon` or `asService`.

## Analysis pipeline rules
- Never claim AI output as fact: measured data (scenes, durations, cut rate) is computed in code; model output goes through Zod schemas plus `checkTimestamps` before it's stored.
- Never fabricate progress or metrics. Show only provider-reported numbers.
- Never download third-party videos from URLs. Only fetch canonical, allow-listed URLs, and only for accessibility checks.
- Run ffmpeg only through `src/server/analysis/media/ffmpeg.ts` (`execFile`, argument arrays, timeouts).
- Bump the prompt version in `ai/prompts.ts` whenever a prompt changes.

## Phase boundary
Phases 1 (Foundation) and 2 (Discover & Analyze) are implemented. **Do not start Phase 3 (Script Lab) without explicit authorization.**
