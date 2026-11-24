import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asAnon,
  asService,
  asUser,
  createUser,
  createWorkspace,
  pool,
  sql,
  type TestUser,
} from "./helpers";

/**
 * Cross-tenant isolation. Tenant A's users must not be able to read or write
 * anything belonging to tenant B through any table or RPC.
 */
let alice: TestUser; // owner of A
let bob: TestUser; // owner of B
let wsA: { id: string };
let wsB: { id: string };

beforeAll(async () => {
  alice = await createUser({ fullName: "Alice" });
  bob = await createUser({ fullName: "Bob" });
  wsA = await createWorkspace(alice, "Tenant A");
  wsB = await createWorkspace(bob, "Tenant B");

  // Give B a social account + credentials + invitation so there is data to leak.
  await asService(async (q) => {
    const { rows } = await q(
      `insert into public.social_accounts (workspace_id, platform, status, username, connected_by, connected_at)
       values ($1, 'instagram', 'connected', 'tenant_b', $2, now()) returning id`,
      [wsB.id, bob.id],
    );
    await q(
      `insert into public.social_account_credentials (social_account_id, workspace_id, encrypted_access_token)
       values ($1, $2, 'v1:ciphertext')`,
      [rows[0].id, wsB.id],
    );
  });
  await asUser(bob, (q) =>
    q("select * from public.create_workspace_invitation($1, 'someone@example.test', 'member')", [wsB.id]),
  );
});

afterAll(() => pool.end());

const TENANT_TABLES = [
  "workspace_members",
  "workspace_settings",
  "subscriptions",
  "usage_credits",
  "usage_transactions",
  "social_accounts",
  "workspace_invitations",
  "audit_logs",
] as const;

describe("cross-tenant read isolation", () => {
  it("hides other tenants' workspaces", async () => {
    const { rows } = await asUser(alice, (q) => q("select id from public.workspaces"));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(wsA.id);
    expect(ids).not.toContain(wsB.id);
  });

  for (const table of TENANT_TABLES) {
    it(`returns no rows from ${table} for another tenant`, async () => {
      const { rows } = await asUser(alice, (q) =>
        q(`select * from public.${table} where workspace_id = $1`, [wsB.id]),
      );
      expect(rows).toHaveLength(0);
    });

    it(`sanity: tenant B can see its own ${table}`, async () => {
      const { rows } = await asUser(bob, (q) => q(`select * from public.${table} where workspace_id = $1`, [wsB.id]));
      expect(rows.length).toBeGreaterThan(0);
    });
  }

  it("hides profiles of users who share no workspace", async () => {
    const { rows } = await asUser(alice, (q) => q("select id from public.profiles where id = $1", [bob.id]));
    expect(rows).toHaveLength(0);
  });

  it("never exposes social credentials to any client role", async () => {
    await expect(asUser(bob, (q) => q("select * from public.social_account_credentials"))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(alice, (q) => q("select * from public.social_account_credentials"))).rejects.toMatchObject({ code: "42501" });
    await expect(asAnon((q) => q("select * from public.social_account_credentials"))).rejects.toMatchObject({ code: "42501" });
  });

  it("denies the anon role on every tenant table", async () => {
    for (const table of ["workspaces", ...TENANT_TABLES]) {
      await expect(asAnon((q) => q(`select * from public.${table}`))).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("does not leak membership through helper functions", async () => {
    const { rows } = await asUser(alice, (q) =>
      q("select public.is_workspace_member($1) as m, public.workspace_role_of($1) as r", [wsB.id]),
    );
    expect(rows[0]).toEqual({ m: false, r: null });
  });
});

describe("cross-tenant write isolation", () => {
  it("cannot update another tenant's workspace or settings", async () => {
    const w = await asUser(alice, (q) => q("update public.workspaces set name = 'pwned' where id = $1", [wsB.id]));
    const s = await asUser(alice, (q) =>
      q("update public.workspace_settings set brand_voice = 'pwned' where workspace_id = $1", [wsB.id]),
    );
    expect(w.rowCount).toBe(0);
    expect(s.rowCount).toBe(0);
    const { rows } = await sql("select name from public.workspaces where id = $1", [wsB.id]);
    expect(rows[0].name).toBe("Tenant B");
  });

  it("cannot insert itself into another tenant's membership", async () => {
    await expect(
      asUser(alice, (q) =>
        q("insert into public.workspace_members (workspace_id, user_id, role) values ($1, $2, 'owner')", [wsB.id, alice.id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot invite, remove members, disconnect social or change roles in another tenant", async () => {
    await expect(
      asUser(alice, (q) => q("select * from public.create_workspace_invitation($1, $2, 'admin')", [wsB.id, alice.email])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(alice, (q) => q("select public.remove_workspace_member($1, $2)", [wsB.id, bob.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(alice, (q) => q("select public.disconnect_social_account($1)", [wsB.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(alice, (q) => q("select public.update_member_role($1, $2, 'member')", [wsB.id, bob.id])),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows } = await sql("select count(*)::int as n from public.social_accounts where workspace_id = $1", [wsB.id]);
    expect(rows[0].n).toBe(1);
  });

  it("cannot revoke another tenant's invitation", async () => {
    const { rows } = await sql("select id from public.workspace_invitations where workspace_id = $1", [wsB.id]);
    await expect(
      asUser(alice, (q) => q("select public.revoke_workspace_invitation($1)", [rows[0].id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot write credits or ledger rows directly", async () => {
    await expect(
      asUser(alice, (q) => q("update public.usage_credits set balance = 999999 where workspace_id = $1", [wsA.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(alice, (q) =>
        q(
          "insert into public.usage_transactions (workspace_id, type, amount, balance_after, reason) values ($1, 'grant', 1000, 1000, 'free money')",
          [wsA.id],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("cannot change its own subscription plan", async () => {
    await expect(
      asUser(alice, (q) => q("update public.subscriptions set plan_id = 'studio' where workspace_id = $1", [wsA.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
