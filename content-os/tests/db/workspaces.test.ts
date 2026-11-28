import { afterAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createUser, createWorkspace, pool, sql, uniqueSlug } from "./helpers";

afterAll(() => pool.end());

describe("workspace creation", () => {
  it("atomically provisions workspace, owner membership, settings, subscription and credits", async () => {
    const owner = await createUser();
    const ws = await createWorkspace(owner, "Acme Studio");

    expect(ws.owner_id).toBe(owner.id);

    const member = await sql("select role from public.workspace_members where workspace_id = $1 and user_id = $2", [ws.id, owner.id]);
    expect(member.rows[0].role).toBe("owner");

    const settings = await sql("select timezone from public.workspace_settings where workspace_id = $1", [ws.id]);
    expect(settings.rows).toHaveLength(1);

    const sub = await sql("select plan_id, status from public.subscriptions where workspace_id = $1", [ws.id]);
    expect(sub.rows[0]).toEqual({ plan_id: "free", status: "active" });

    const credits = await sql("select balance from public.usage_credits where workspace_id = $1", [ws.id]);
    expect(credits.rows[0].balance).toBe(50);

    const txns = await sql("select type, amount, balance_after from public.usage_transactions where workspace_id = $1", [ws.id]);
    expect(txns.rows).toEqual([{ type: "grant", amount: 50, balance_after: 50 }]);

    const audit = await sql("select action from public.audit_logs where workspace_id = $1", [ws.id]);
    expect(audit.rows.map((r) => r.action)).toContain("workspace.created");
  });

  it("normalises the slug to lowercase and trims the name", async () => {
    const owner = await createUser();
    const slug = uniqueSlug("Mixed");
    const ws = await createWorkspace(owner, "  Spaced Name  ", slug.toUpperCase());
    expect(ws.slug).toBe(slug.toLowerCase());
    expect(ws.name).toBe("Spaced Name");
  });

  it("rejects invalid slugs and names", async () => {
    const owner = await createUser();
    await expect(createWorkspace(owner, "Ok name", "bad slug!")).rejects.toMatchObject({ code: "23514" });
    await expect(createWorkspace(owner, "x", uniqueSlug())).rejects.toMatchObject({ code: "23514" });
  });

  it("rejects duplicate slugs", async () => {
    const a = await createUser();
    const b = await createUser();
    const slug = uniqueSlug();
    await createWorkspace(a, "First", slug);
    await expect(createWorkspace(b, "Second", slug)).rejects.toMatchObject({ code: "23505" });
  });

  it("rolls back every row when creation fails midway", async () => {
    const owner = await createUser();
    const slug = uniqueSlug();
    await createWorkspace(owner, "Taken", slug);
    const before = await sql("select count(*)::int as n from public.workspace_members where user_id = $1", [owner.id]);
    await expect(createWorkspace(owner, "Dup", slug)).rejects.toBeTruthy();
    const after = await sql("select count(*)::int as n from public.workspace_members where user_id = $1", [owner.id]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("caps the number of workspaces a user can own", async () => {
    const owner = await createUser();
    for (let i = 0; i < 5; i++) await createWorkspace(owner, `WS ${i}`);
    await expect(createWorkspace(owner, "One too many")).rejects.toThrow(/limit/);
  });

  it("does not allow anonymous callers to create workspaces", async () => {
    await expect(
      asAnon((q) => q("select public.create_workspace('Anon', $1)", [uniqueSlug()])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not allow direct inserts that bypass the RPC", async () => {
    const user = await createUser();
    await expect(
      asUser(user, (q) =>
        q("insert into public.workspaces (name, slug, owner_id) values ('Direct', $1, $2)", [uniqueSlug(), user.id]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("allows owners to rename the workspace but not change slug or owner", async () => {
    const owner = await createUser();
    const ws = await createWorkspace(owner);
    const res = await asUser(owner, (q) => q("update public.workspaces set name = 'Renamed' where id = $1", [ws.id]));
    expect(res.rowCount).toBe(1);
    await expect(
      asUser(owner, (q) => q("update public.workspaces set slug = 'hijack' where id = $1", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(owner, (q) => q("update public.workspaces set owner_id = $2 where id = $1", [ws.id, owner.id])),
    ).rejects.toMatchObject({ code: "42501" });
    const audit = await sql("select action from public.audit_logs where workspace_id = $1", [ws.id]);
    expect(audit.rows.map((r) => r.action)).toContain("workspace.renamed");
  });
});
