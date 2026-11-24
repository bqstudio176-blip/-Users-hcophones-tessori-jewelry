import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * DB test harness. Mimics how Supabase/PostgREST executes requests:
 *   BEGIN; SET LOCAL ROLE <role>; set_config('request.jwt.claims', ...); <query>; COMMIT
 * so RLS policies, column grants and function privileges are evaluated exactly
 * as they would be for a real API call.
 */
export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://postgres@127.0.0.1:54329/content_os_test";

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export type Q = (sql: string, params?: unknown[]) => Promise<pg.QueryResult>;

export interface TestUser {
  id: string;
  email: string;
}

export function uniqueEmail(prefix = "user"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}@example.test`;
}

export function uniqueSlug(prefix = "ws"): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

/** Superuser query (setup only — bypasses RLS like a migration would). */
export async function sql(text: string, params?: unknown[]) {
  return pool.query(text, params);
}

/** Simulates a Supabase Auth sign-up. Trigger provisions public.profiles. */
export async function createUser(
  opts: { email?: string; confirmed?: boolean; fullName?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? uniqueEmail();
  const { rows } = await pool.query(
    `insert into auth.users (email, email_confirmed_at, raw_user_meta_data)
     values ($1, $2, $3) returning id, email`,
    [
      email,
      opts.confirmed === false ? null : new Date().toISOString(),
      JSON.stringify(opts.fullName ? { full_name: opts.fullName } : {}),
    ],
  );
  return rows[0];
}

async function withRole<T>(
  role: "anon" | "authenticated" | "service_role",
  claims: Record<string, unknown>,
  fn: (q: Q) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const result = await fn((text, params) => client.query(text, params));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function asUser<T>(user: TestUser, fn: (q: Q) => Promise<T>) {
  return withRole("authenticated", { sub: user.id, role: "authenticated", email: user.email }, fn);
}

export function asAnon<T>(fn: (q: Q) => Promise<T>) {
  return withRole("anon", { role: "anon" }, fn);
}

export function asService<T>(fn: (q: Q) => Promise<T>) {
  return withRole("service_role", { role: "service_role" }, fn);
}

/** Creates a workspace through the real RPC, as the given (verified) user. */
export async function createWorkspace(owner: TestUser, name = "Test Workspace", slug = uniqueSlug()) {
  const { rows } = await asUser(owner, (q) =>
    q("select * from public.create_workspace($1, $2)", [name, slug]),
  );
  return rows[0] as { id: string; name: string; slug: string; owner_id: string };
}

/** Owner invites `user` with `role`; user accepts. Returns nothing. */
export async function addMember(
  workspaceId: string,
  inviter: TestUser,
  user: TestUser,
  role: "admin" | "member",
) {
  const { rows } = await asUser(inviter, (q) =>
    q("select * from public.create_workspace_invitation($1, $2, $3)", [workspaceId, user.email, role]),
  );
  await asUser(user, (q) => q("select public.accept_workspace_invitation($1)", [rows[0].token]));
}

/** Raise the seat limit so role tests are not constrained by the free plan. */
export async function upgradePlan(workspaceId: string, planId = "studio") {
  await sql("update public.subscriptions set plan_id = $2 where workspace_id = $1", [workspaceId, planId]);
}

export async function makePlatformAdmin(user: TestUser) {
  await sql("update public.profiles set is_platform_admin = true where id = $1", [user.id]);
}
