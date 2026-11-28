import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  asUser,
  createUser,
  createWorkspace,
  pool,
  sql,
  uniqueEmail,
  upgradePlan,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let admin: TestUser;
let member: TestUser;
let ws: { id: string };

beforeAll(async () => {
  owner = await createUser();
  admin = await createUser();
  member = await createUser();
  ws = await createWorkspace(owner, "Roles WS");
  await upgradePlan(ws.id);
  await addMember(ws.id, owner, admin, "admin");
  await addMember(ws.id, owner, member, "member");
});

afterAll(() => pool.end());

async function roleOf(user: TestUser) {
  const { rows } = await sql("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, user.id]);
  return rows[0]?.role ?? null;
}

describe("workspace settings permissions", () => {
  it("owner and admin can update settings; member cannot", async () => {
    const o = await asUser(owner, (q) => q("update public.workspace_settings set content_niche = 'fitness' where workspace_id = $1", [ws.id]));
    const a = await asUser(admin, (q) => q("update public.workspace_settings set timezone = 'Europe/Madrid' where workspace_id = $1", [ws.id]));
    const m = await asUser(member, (q) => q("update public.workspace_settings set brand_voice = 'x' where workspace_id = $1", [ws.id]));
    expect([o.rowCount, a.rowCount, m.rowCount]).toEqual([1, 1, 0]);
  });

  it("member cannot rename the workspace", async () => {
    const res = await asUser(member, (q) => q("update public.workspaces set name = 'Member Rename' where id = $1", [ws.id]));
    expect(res.rowCount).toBe(0);
  });

  it("all members can read workspace, settings, members and subscription", async () => {
    for (const u of [owner, admin, member]) {
      const { rows } = await asUser(u, (q) =>
        q(
          `select (select count(*) from public.workspaces where id = $1)::int as w,
                  (select count(*) from public.workspace_settings where workspace_id = $1)::int as s,
                  (select count(*) from public.workspace_members where workspace_id = $1)::int as m,
                  (select count(*) from public.subscriptions where workspace_id = $1)::int as sub`,
          [ws.id],
        ),
      );
      expect(rows[0]).toEqual({ w: 1, s: 1, m: 3, sub: 1 });
    }
  });

  it("members can see colleagues' profiles", async () => {
    const { rows } = await asUser(member, (q) => q("select id from public.profiles where id = $1", [owner.id]));
    expect(rows).toHaveLength(1);
  });
});

describe("invitations", () => {
  it("member cannot invite", async () => {
    await expect(
      asUser(member, (q) => q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, uniqueEmail()])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("admin can invite members but not admins", async () => {
    const { rows } = await asUser(admin, (q) =>
      q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, uniqueEmail()]),
    );
    expect(rows[0].token).toMatch(/^[0-9a-f]{64}$/);
    await expect(
      asUser(admin, (q) => q("select * from public.create_workspace_invitation($1, $2, 'admin')", [ws.id, uniqueEmail()])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("nobody can invite an owner", async () => {
    await expect(
      asUser(owner, (q) => q("select * from public.create_workspace_invitation($1, $2, 'owner')", [ws.id, uniqueEmail()])),
    ).rejects.toThrow(/owner/);
  });

  it("stores only a hash of the invitation token", async () => {
    const { rows } = await asUser(owner, (q) =>
      q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, uniqueEmail()]),
    );
    const stored = await sql("select token_hash from public.workspace_invitations where id = $1", [rows[0].invitation_id]);
    expect(stored.rows[0].token_hash).not.toBe(rows[0].token);
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("only the invited email can accept, and only once", async () => {
    const invitee = await createUser();
    const stranger = await createUser();
    const { rows } = await asUser(owner, (q) =>
      q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, invitee.email]),
    );
    const token = rows[0].token;
    await expect(asUser(stranger, (q) => q("select public.accept_workspace_invitation($1)", [token]))).rejects.toThrow(/invalid/);
    await asUser(invitee, (q) => q("select public.accept_workspace_invitation($1)", [token]));
    expect(await roleOf(invitee)).toBe("member");
    await expect(asUser(invitee, (q) => q("select public.accept_workspace_invitation($1)", [token]))).rejects.toThrow(/invalid/);
  });

  it("rejects expired and revoked invitations", async () => {
    const invitee = await createUser();
    const { rows } = await asUser(owner, (q) =>
      q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, invitee.email]),
    );
    await sql("update public.workspace_invitations set expires_at = now() - interval '1 minute' where id = $1", [rows[0].invitation_id]);
    await expect(asUser(invitee, (q) => q("select public.accept_workspace_invitation($1)", [rows[0].token]))).rejects.toThrow(/invalid/);

    const invitee2 = await createUser();
    const inv2 = await asUser(owner, (q) =>
      q("select * from public.create_workspace_invitation($1, $2, 'member')", [ws.id, invitee2.email]),
    );
    await asUser(admin, (q) => q("select public.revoke_workspace_invitation($1)", [inv2.rows[0].invitation_id]));
    await expect(asUser(invitee2, (q) => q("select public.accept_workspace_invitation($1)", [inv2.rows[0].token]))).rejects.toThrow(/invalid/);
  });

  it("members cannot list invitations", async () => {
    const { rows } = await asUser(member, (q) => q("select * from public.workspace_invitations where workspace_id = $1", [ws.id]));
    expect(rows).toHaveLength(0);
  });

  it("enforces the plan seat limit", async () => {
    const o = await createUser();
    const small = await createWorkspace(o, "Small"); // free plan: 2 seats
    await asUser(o, (q) => q("select * from public.create_workspace_invitation($1, $2, 'member')", [small.id, uniqueEmail()]));
    await expect(
      asUser(o, (q) => q("select * from public.create_workspace_invitation($1, $2, 'member')", [small.id, uniqueEmail()])),
    ).rejects.toThrow(/limit/);
  });
});

describe("member management", () => {
  it("only the owner can change roles", async () => {
    const target = await createUser();
    await addMember(ws.id, owner, target, "member");
    await expect(asUser(admin, (q) => q("select public.update_member_role($1, $2, 'admin')", [ws.id, target.id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(owner, (q) => q("select public.update_member_role($1, $2, 'admin')", [ws.id, target.id]));
    expect(await roleOf(target)).toBe("admin");
    await asUser(owner, (q) => q("select public.update_member_role($1, $2, 'member')", [ws.id, target.id]));
    expect(await roleOf(target)).toBe("member");
  });

  it("the owner role cannot be reassigned or removed", async () => {
    await expect(asUser(owner, (q) => q("select public.update_member_role($1, $2, 'member')", [ws.id, owner.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(owner, (q) => q("select public.update_member_role($1, $2, 'owner')", [ws.id, admin.id]))).rejects.toThrow(/ownership/);
    await expect(asUser(owner, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, owner.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(admin, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, owner.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("admin can remove members but not other admins", async () => {
    const m = await createUser();
    const a2 = await createUser();
    await addMember(ws.id, owner, m, "member");
    await addMember(ws.id, owner, a2, "admin");
    await asUser(admin, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, m.id]));
    expect(await roleOf(m)).toBeNull();
    await expect(asUser(admin, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, a2.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("member cannot remove others but can leave", async () => {
    const leaver = await createUser();
    await addMember(ws.id, owner, leaver, "member");
    await expect(asUser(member, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, leaver.id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(leaver, (q) => q("select public.remove_workspace_member($1, $2)", [ws.id, leaver.id]));
    expect(await roleOf(leaver)).toBeNull();
    // After leaving, the workspace is invisible.
    const { rows } = await asUser(leaver, (q) => q("select id from public.workspaces where id = $1", [ws.id]));
    expect(rows).toHaveLength(0);
  });

  it("enforces exactly one owner at the database level", async () => {
    await expect(sql("update public.workspace_members set role = 'owner' where workspace_id = $1 and user_id = $2", [ws.id, admin.id])).rejects.toMatchObject({ code: "23505" });
  });
});

describe("audit log visibility", () => {
  it("owner and admin can read the workspace audit log; member cannot", async () => {
    const counts = [];
    for (const u of [owner, admin, member]) {
      const { rows } = await asUser(u, (q) => q("select count(*)::int as n from public.audit_logs where workspace_id = $1", [ws.id]));
      counts.push(rows[0].n);
    }
    expect(counts[0]).toBeGreaterThan(0);
    expect(counts[1]).toBe(counts[0]);
    expect(counts[2]).toBe(0);
  });

  it("clients cannot write audit logs directly or via the internal function", async () => {
    await expect(
      asUser(owner, (q) => q("insert into public.audit_logs (workspace_id, action) values ($1, 'fake.event')", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(owner, (q) => q("select public.log_audit_event($1, 'fake.event')", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
