import { afterAll, describe, expect, it } from "vitest";
import { asAnon, asUser, createUser, pool, sql, uniqueSlug } from "./helpers";

afterAll(() => pool.end());

describe("auth → profile provisioning", () => {
  it("creates a profile when a Supabase Auth user registers", async () => {
    const user = await createUser({ fullName: "Ada Lovelace" });
    const { rows } = await sql("select id, email, full_name, is_platform_admin from public.profiles where id = $1", [user.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: user.email, full_name: "Ada Lovelace", is_platform_admin: false });
  });

  it("records a user.registered audit event", async () => {
    const user = await createUser();
    const { rows } = await sql("select action from public.audit_logs where actor_id = $1", [user.id]);
    expect(rows.map((r) => r.action)).toContain("user.registered");
  });

  it("keeps profile email in sync when the auth email changes", async () => {
    const user = await createUser();
    const next = `changed-${user.email}`;
    await sql("update auth.users set email = $2 where id = $1", [user.id, next]);
    const { rows } = await sql("select email from public.profiles where id = $1", [user.id]);
    expect(rows[0].email).toBe(next);
  });

  it("lets a user read and update their own profile", async () => {
    const user = await createUser();
    await asUser(user, (q) =>
      q("update public.profiles set full_name = 'New Name', preferences = '{\"theme\":\"light\"}' where id = $1", [user.id]),
    );
    const { rows } = await asUser(user, (q) => q("select full_name, preferences from public.profiles where id = $1", [user.id]));
    expect(rows[0]).toMatchObject({ full_name: "New Name", preferences: { theme: "light" } });
  });

  it("prevents a user from granting themselves platform admin", async () => {
    const user = await createUser();
    await expect(
      asUser(user, (q) => q("update public.profiles set is_platform_admin = true where id = $1", [user.id])),
    ).rejects.toMatchObject({ code: "42501" });
    const { rows } = await sql("select is_platform_admin from public.profiles where id = $1", [user.id]);
    expect(rows[0].is_platform_admin).toBe(false);
  });

  it("prevents a user from changing their profile email directly", async () => {
    const user = await createUser();
    await expect(
      asUser(user, (q) => q("update public.profiles set email = 'x@evil.test' where id = $1", [user.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("does not let a user modify another user's profile", async () => {
    const a = await createUser();
    const b = await createUser({ fullName: "Bob" });
    const res = await asUser(a, (q) => q("update public.profiles set full_name = 'pwned' where id = $1", [b.id]));
    expect(res.rowCount).toBe(0);
    const { rows } = await sql("select full_name from public.profiles where id = $1", [b.id]);
    expect(rows[0].full_name).toBe("Bob");
  });

  it("denies anonymous access to profiles", async () => {
    await createUser();
    await expect(asAnon((q) => q("select * from public.profiles"))).rejects.toMatchObject({ code: "42501" });
  });

  it("requires a verified email before creating a workspace", async () => {
    const unverified = await createUser({ confirmed: false });
    await expect(
      asUser(unverified, (q) => q("select public.create_workspace('Nope', $1)", [uniqueSlug()])),
    ).rejects.toThrow(/verified/);
  });
});
