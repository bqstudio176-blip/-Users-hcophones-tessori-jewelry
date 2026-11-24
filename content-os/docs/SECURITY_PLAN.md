# Security Plan — Content OS (Phase 1)

> **Status: DRAFT, reconstructed during Phase 1. Not yet approved.** It records the controls actually implemented and the risks that remain.

## 1. Principles

1. **Deny by default.** RLS is enabled on every table, and table privileges are revoked from `anon` and `authenticated` before specific grants are added.
2. **Authorization lives in the database.** The UI and server actions check permissions too, but RLS and RPC checks are what actually decide.
3. **Identity comes from the session, never from arguments.** RPCs use `auth.uid()`.
4. **Least privilege for secrets.** The service-role key is used in exactly one code path, and OAuth tokens are encrypted with keys the database never sees.

## 2. Authentication

- Supabase Auth with email and password. Email verification is required before creating or joining a workspace. This is enforced in the database (`create_workspace`, `accept_workspace_invitation`) and in the app (`requireVerifiedUser`).
- Password policy: at least 10 and at most 72 characters, with lowercase, uppercase and a digit. It is checked with zod on the server and should also be set in Supabase Auth (see `supabase/config.toml`).
- Sessions use httpOnly cookies managed by `@supabase/ssr` and are refreshed in `proxy.ts`. Server code uses `getUser()`, which checks the session with Supabase Auth.
- No account enumeration: sign-up, password reset and resend-verification return the same response whether or not the account exists.
- Post-login redirects go through `safeNextPath` (same-origin paths only), which prevents open redirects.
- Changing a password requires the current password. "Sign out everywhere" revokes all refresh tokens.
- Rate limiting relies on Supabase Auth's built-in limits. 429 responses are shown to the user.

## 3. Authorization matrix

| Capability | Owner | Admin | Member | Enforced by |
|---|:-:|:-:|:-:|---|
| View workspace, settings, members, plan, credits, social status | ✓ | ✓ | ✓ | RLS `*_select_member` |
| Rename workspace / edit settings | ✓ | ✓ | – | RLS update policies plus column grants |
| Invite members | ✓ | ✓ | – | `create_workspace_invitation` |
| Invite admins | ✓ | – | – | `create_workspace_invitation` |
| Change roles | ✓ | – | – | `update_member_role` |
| Remove members | ✓ (any non-owner) | ✓ (members only) | – (may leave) | `remove_workspace_member` |
| Connect or disconnect Instagram | ✓ | ✓ | – | Route handler check plus `disconnect_social_account` |
| View audit log | ✓ | ✓ | – | RLS `audit_logs_select_admin` |
| Change plan or credits | – | – | – | No client privilege. Platform admins can only call `admin_adjust_credits`. |
| Read social credentials | – | – | – | No policy and no privilege, for any client role (platform admins included) |

Platform admins (`profiles.is_platform_admin`) get **read-only** visibility across tenants through RLS. Their only write is the credit adjustment RPC. Admin pages return **404** to everyone else.

## 4. Tenant isolation

- Every tenant table has a `workspace_id`, and its policies call `is_workspace_member(workspace_id)`.
- The helper functions are `SECURITY DEFINER` so policies on `workspace_members` don't recurse into themselves.
- Clients have no INSERT or DELETE privileges on tenant tables. Multi-row operations go through RPCs that re-check the role.
- The active-workspace cookie is checked against memberships on every request.
- **Tested:** `tests/db/rls-isolation.test.ts` covers 27 cross-tenant read and write attempts across every table and RPC.

## 5. Secrets and credentials

| Secret | Storage | Access |
|---|---|---|
| Supabase service-role key | Server environment variable `SUPABASE_SERVICE_ROLE_KEY` | `src/lib/supabase/admin.ts` (`server-only`), used only by the Instagram callback |
| Instagram access tokens | `social_account_credentials.encrypted_access_token` | AES-256-GCM with a random IV and the workspace ID as additional authenticated data. Keys are `TOKEN_ENCRYPTION_KEY_V<n>`, rotated by version. RLS is on with no policies, and privileges are revoked from `anon` and `authenticated`. |
| OAuth state | HMAC-SHA256 signed with `OAUTH_STATE_SECRET`, expires after 10 minutes | Bound to the browser (nonce cookie) and to the user |
| Invitation tokens | Only the SHA-256 hash is stored | Plaintext is shown once to the inviter |

Tokens never reach the browser. Error messages from Instagram are logged without secrets.

## 6. Data integrity

- The credit ledger is append-only: UPDATE and DELETE are revoked even from `service_role`. Balance changes happen only through `apply_credit_transaction`, which takes a row lock, rejects overdrafts and supports idempotency keys.
- The audit log is append-only, and clients cannot write to it.
- `SECURITY DEFINER` functions use `search_path = ''` and fully qualified names.

## 7. Web hardening

- Headers: `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, HSTS, a restrictive `Permissions-Policy`, and no `X-Powered-By`.
- Server Actions get Next.js's built-in origin check, which protects against CSRF. The OAuth flow is protected by the state and nonce.
- The app is not indexed by search engines (`robots: noindex`).

## 8. Known gaps and risks

| # | Gap | Severity | Plan |
|---|---|---|---|
| 1 | No Content-Security-Policy header yet | Medium | Add a nonce-based CSP in `proxy.ts` (Phase 2). |
| 2 | No MFA | Medium | Supabase MFA (TOTP) in a later phase. |
| 3 | No application-level rate limiting on server actions such as invitations | Low/Medium | Supabase Auth limits cover auth endpoints. Add per-user limits for RPCs. |
| 4 | Instagram token refresh is not implemented (long-lived tokens expire after about 60 days) | Medium | Scheduled refresh job in Phase 2. The status model already supports `expired`. |
| 5 | Supabase API integration not verified end to end against a live project | High (verification) | See IMPLEMENTATION_STATUS.md. Run the manual acceptance script before launch. |
| 6 | Workspace and account deletion not implemented (`owner_id` uses `on delete restrict`) | Low | Add with a data-export/retention policy. |

---

## 9. Phase 2 controls: Discover and Analyze

| Risk | Control | Verified by |
|---|---|---|
| Cross-tenant access to references, searches, analyses | RLS on all 13 new tables; triggers reject tags and results that point to another workspace; storage paths start with the workspace id and storage policies check membership | `tests/db/references.test.ts`, `tests/db/analysis-jobs.test.ts` |
| Tampering with analysis results | Users have SELECT only on all analysis output (they can update `user_notes` alone); worker functions are executable only by `service_role`; worker lock checks prevent another worker from finishing a job | `analysis-jobs.test.ts` |
| SSRF via imported URLs | Only https; IP literals, localhost, `.internal`, credentials in URLs and non-443 ports rejected. The server fetches only canonical URLs it builds itself for Instagram and YouTube, without following redirects, with a 6-second timeout. Other sites are stored but never fetched. | `tests/unit/discover-url.test.ts`, `discovery-providers.test.ts` |
| Malicious uploads | Type and size checked in the browser, server action, database RPC and bucket config; uploads only to the reserved path; the worker checks magic bytes, then ffprobe, duration and size limits; files are only *read* by ffmpeg through `execFile` argument arrays (no shell, timeouts, bounded output) and never executed | `pipeline.test.ts` (a shell script disguised as `.mp4` is rejected, and the test checks it was not executed) |
| Media exposure | Private bucket; the browser only gets 1-hour signed URLs minted with the user's own client (RLS-checked) | Storage policy tests |
| Credit abuse | Atomic charge in `request_analysis`; one active analysis per reference; idempotency key per form; refunds exactly once on failure or cancel | `analysis-jobs.test.ts` |
| Provider credentials | All API keys are server or worker environment variables; Instagram tokens are decrypted server-side only after a membership check; no key reaches the browser | Code review |
| Prompt injection from video content | Transcript and on-screen text are untrusted. The model has no tools; output is limited to a JSON schema, validated, and rendered as plain text by React (no HTML). Worst case is a misleading report, not an action. | Design |
| Fabricated insights | Measured facts are computed in code; schemas separate evidence from interpretation; timestamps are checked against the real duration; prompts forbid performance and retention claims; the report states what inputs were used | `analysis-modules.test.ts`, `pipeline.test.ts` |
| Copyright and platform terms | No downloading from third-party platforms; uploads require the user to hold the rights (UI notice); creative prompts transfer techniques and must not reproduce scripts | Design and UI |

### Phase 2 residual risks

| # | Risk | Severity | Mitigation / plan |
|---|---|---|---|
| P2-1 | ffmpeg parses untrusted media, so a decoder vulnerability is possible | Medium | Run the worker in its own container with no inbound network, no shell, as a non-root user (`USER node`), and with timeouts. Keep ffmpeg patched. Consider seccomp or gVisor. |
| P2-2 | No per-user rate limit on searches; one member could exhaust the YouTube quota | Low | Add per-workspace search limits (Phase 3). |
| P2-3 | `url_check` and `metrics` on manually imported references can be written by members of that workspace | Low | Affects only their own workspace's display. The values are labelled with their source. |
| P2-4 | Live provider behaviour (Claude, Whisper, YouTube, Instagram, Supabase Storage) not verified | High (verification, not a known flaw) | See IMPLEMENTATION_STATUS.md Phase 2 checklist. |

No known critical- or high-severity security flaw remains open in the Phase 2 code. P2-4 is a verification gap, not a known flaw.
