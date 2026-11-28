import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asUser, createUser, createWorkspace, makePlatformAdmin, pool, type TestUser } from "./helpers";

let staff: TestUser;
let regular: TestUser;
let tenantOwner: TestUser;
let tenant: { id: string };

beforeAll(async () => {
  staff = await createUser();
  regular = await createUser();
  tenantOwner = await createUser();
  await makePlatformAdmin(staff);
  tenant = await createWorkspace(tenantOwner, "Customer");
});

afterAll(() => pool.end());

describe("platform admin visibility", () => {
  it("platform admins can read all workspaces, users, subscriptions and activity", async () => {
    const { rows } = await asUser(staff, (q) =>
      q(
        `select
           (select count(*) from public.workspaces where id = $1)::int as ws,
           (select count(*) from public.profiles where id = $2)::int as profile,
           (select count(*) from public.subscriptions where workspace_id = $1)::int as sub,
           (select count(*) from public.audit_logs where workspace_id = $1)::int as audit`,
        [tenant.id, tenantOwner.id],
      ),
    );
    expect(rows[0]).toEqual({ ws: 1, profile: 1, sub: 1, audit: 1 });
  });

  it("regular users get none of that", async () => {
    const { rows } = await asUser(regular, (q) =>
      q(
        `select
           (select count(*) from public.workspaces)::int as ws,
           (select count(*) from public.profiles where id <> $1)::int as profiles,
           (select count(*) from public.subscriptions)::int as sub,
           (select count(*) from public.audit_logs where workspace_id is not null)::int as audit`,
        [regular.id],
      ),
    );
    expect(rows[0]).toEqual({ ws: 0, profiles: 0, sub: 0, audit: 0 });
  });

  it("is_platform_admin() reflects the caller", async () => {
    const a = await asUser(staff, (q) => q("select public.is_platform_admin() as v"));
    const b = await asUser(regular, (q) => q("select public.is_platform_admin() as v"));
    expect([a.rows[0].v, b.rows[0].v]).toEqual([true, false]);
  });

  it("platform admins still cannot read social credentials", async () => {
    await expect(asUser(staff, (q) => q("select * from public.social_account_credentials"))).rejects.toMatchObject({ code: "42501" });
  });

  it("platform admins cannot mutate tenant data through RLS (read-only visibility)", async () => {
    const res = await asUser(staff, (q) => q("update public.workspaces set name = 'staff edit' where id = $1", [tenant.id]));
    expect(res.rowCount).toBe(0);
  });
});
