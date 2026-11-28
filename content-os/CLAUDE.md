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

## Script Lab / creative engine rules
- Agents never change saved content. AI edits go to `scripts.pending_proposal` and are applied only through `replace_script_content(..., 'ai_edit_applied')` after explicit user confirmation. Locked scenes and stale proposals are rejected in the RPC.
- Every agent output goes through its Zod schema and its validator in `src/server/creative/validators.ts` (citations, forbidden claims, originality ≤ 15%, duration, locked scenes).
- Wrap all user and third-party text with `untrustedBlock()` before it reaches a prompt.
- Credits are charged only by `record_ai_agent_run` with status `succeeded`. Never charge before the model call.
- Recommendations carry provenance (`observed` with a cited id, `user`, or `hypothesis`). Never present a hypothesis as fact or promise performance.
- Bump the version in `src/server/creative/prompts.ts` whenever a prompt changes. Never edit an applied seed migration; add a new one.

## Video Studio rules
- Only user-owned media: uploads need a rights confirmation. Never add URL downloads, stock media or a music catalogue.
- Never interpolate user text into an ffmpeg filter graph. Text goes through `buildAss()` / `assEscape()`; the render plan comes from `buildRenderPlan()` on a zod-validated timeline.
- Timeline saves go through `save_video_timeline` with the expected version. Never overwrite on conflict.
- Measured facts (durations, loudness, resolution) come from ffprobe/ebur128. Estimated caption timing must be labelled as estimated.
- Render credits are charged by `request_render` and refunded only by the worker/RPC failure paths (exactly once).

## Phase boundary
Phases 1 (Foundation), 2 (Discover & Analyze), 3 (Script Lab & Creative Intelligence) and 4 (Video Studio) are implemented. **Do not start Phase 5 without explicit authorization.**
