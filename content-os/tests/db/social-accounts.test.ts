import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asService, asUser, createUser, createWorkspace, pool, sql, type TestUser } from "./helpers";

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let ws: { id: string };

async function connect(workspaceId: string, username = "creator") {
  return asService(async (q) => {
    const { rows } = await q(
      `insert into public.social_accounts (workspace_id, platform, status, username, external_account_id, connected_at)
       values ($1, 'instagram', 'connected', $2, $3, now()) returning id`,
      [workspaceId, username, `ig-${username}`],
    );
    await q(
      `insert into public.social_account_credentials (social_account_id, workspace_id, encrypted_access_token)
       values ($1, $2, 'v1:iv:tag:ciphertext')`,
      [rows[0].id, workspaceId],
    );
    return rows[0].id as string;
  });
}

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser();
  member = await createUser();
  ws = await createWorkspace(owner, "Social WS");
  await sql("update public.subscriptions set plan_id = 'studio' where workspace_id = $1", [ws.id]);
  await addMember(ws.id, owner, admin, "admin");
  await addMember(ws.id, owner, member, "member");
});

afterAll(() => pool.end());

describe("one social account per workspace", () => {
  it("rejects a second social account for the same workspace at the database level", async () => {
    await connect(ws.id, "first");
    await expect(connect(ws.id, "second")).rejects.toMatchObject({
      code: "23505",
      constraint: "social_accounts_one_per_workspace",
    });
    const { rows } = await sql("select count(*)::int as n from public.social_accounts where workspace_id = $1", [ws.id]);
    expect(rows[0].n).toBe(1);
  });

  it("allows one credentials row per workspace only", async () => {
    const { rows } = await sql("select id from public.social_accounts where workspace_id = $1", [ws.id]);
    await expect(
      asService((q) =>
        q("insert into public.social_account_credentials (social_account_id, workspace_id, encrypted_access_token) values ($1, $2, 'dup')", [
          rows[0].id,
          ws.id,
        ]),
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("records a social.connected audit event", async () => {
    const { rows } = await sql("select action from public.audit_logs where workspace_id = $1", [ws.id]);
    expect(rows.map((r) => r.action)).toContain("social.connected");
  });
});

describe("social account access control", () => {
  it("every member can read connection status metadata", async () => {
    for (const u of [owner, admin, member]) {
      const { rows } = await asUser(u, (q) => q("select status, username from public.social_accounts where workspace_id = $1", [ws.id]));
      expect(rows[0]).toEqual({ status: "connected", username: "first" });
    }
  });

  it("no member — not even the owner — can read credentials", async () => {
    for (const u of [owner, admin, member]) {
      await expect(
        asUser(u, (q) => q("select encrypted_access_token from public.social_account_credentials")),
      ).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("clients cannot create or modify social accounts directly", async () => {
    const other = await createUser();
    const ws2 = await createWorkspace(other, "Other");
    await expect(
      asUser(other, (q) => q("insert into public.social_accounts (workspace_id, status) values ($1, 'connected')", [ws2.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(owner, (q) => q("update public.social_accounts set status = 'connected', username = 'spoof' where workspace_id = $1", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("a member cannot disconnect", async () => {
    await expect(asUser(member, (q) => q("select public.disconnect_social_account($1)", [ws.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("an admin can disconnect, which also destroys stored credentials", async () => {
    await asUser(admin, (q) => q("select public.disconnect_social_account($1)", [ws.id]));
    const acc = await sql("select count(*)::int as n from public.social_accounts where workspace_id = $1", [ws.id]);
    const cred = await sql("select count(*)::int as n from public.social_account_credentials where workspace_id = $1", [ws.id]);
    expect(acc.rows[0].n).toBe(0);
    expect(cred.rows[0].n).toBe(0);
    const audit = await sql("select action from public.audit_logs where workspace_id = $1", [ws.id]);
    expect(audit.rows.map((r) => r.action)).toContain("social.disconnected");
  });

  it("after disconnecting, a new account can be connected", async () => {
    await expect(connect(ws.id, "replacement")).resolves.toBeTruthy();
  });

  it("status transitions are audited", async () => {
    await asService((q) => q("update public.social_accounts set status = 'expired' where workspace_id = $1", [ws.id]));
    const { rows } = await sql("select metadata from public.audit_logs where workspace_id = $1 and action = 'social.status_changed'", [ws.id]);
    expect(rows.at(-1)?.metadata).toEqual({ from: "connected", to: "expired" });
  });
});
