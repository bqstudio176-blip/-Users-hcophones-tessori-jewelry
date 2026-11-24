import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asService, asUser, createUser, createWorkspace, makePlatformAdmin, pool, sql, type TestUser } from "./helpers";

let owner: TestUser;
let ws: { id: string };

const apply = (wsId: string, type: string, amount: number, reason = "test", key: string | null = null) =>
  asService((q) =>
    q("select * from public.apply_credit_transaction($1, $2::public.credit_transaction_type, $3, $4, null, $5)", [
      wsId,
      type,
      amount,
      reason,
      key,
    ]),
  ).then((r) => r.rows[0]);

async function balance(wsId: string): Promise<number> {
  const { rows } = await sql("select balance from public.usage_credits where workspace_id = $1", [wsId]);
  return rows[0].balance;
}

async function ledgerSum(wsId: string): Promise<number> {
  const { rows } = await sql("select coalesce(sum(amount), 0)::int as s from public.usage_transactions where workspace_id = $1", [wsId]);
  return rows[0].s;
}

beforeAll(async () => {
  owner = await createUser();
  ws = await createWorkspace(owner, "Credits WS"); // starts with 50 credits
});

afterAll(() => pool.end());

describe("usage transaction integrity", () => {
  it("consumes credits and records balance_after", async () => {
    const txn = await apply(ws.id, "consume", -10, "script generation");
    expect(txn).toMatchObject({ type: "consume", amount: -10, balance_after: 40 });
    expect(await balance(ws.id)).toBe(40);
  });

  it("rejects overdrafts without writing anything", async () => {
    const before = await balance(ws.id);
    const { rows: countBefore } = await sql("select count(*)::int as n from public.usage_transactions where workspace_id = $1", [ws.id]);
    await expect(apply(ws.id, "consume", -1000)).rejects.toThrow(/insufficient credits/);
    const { rows: countAfter } = await sql("select count(*)::int as n from public.usage_transactions where workspace_id = $1", [ws.id]);
    expect(await balance(ws.id)).toBe(before);
    expect(countAfter[0].n).toBe(countBefore[0].n);
  });

  it("is idempotent when an idempotency key is supplied", async () => {
    const before = await balance(ws.id);
    const first = await apply(ws.id, "consume", -5, "render", "job-123");
    const replay = await apply(ws.id, "consume", -5, "render", "job-123");
    expect(replay.id).toBe(first.id);
    expect(await balance(ws.id)).toBe(before - 5);
  });

  it("enforces the sign of each transaction type", async () => {
    await expect(apply(ws.id, "consume", 5)).rejects.toMatchObject({ code: "23514" });
    await expect(apply(ws.id, "grant", -5)).rejects.toMatchObject({ code: "23514" });
    await expect(apply(ws.id, "refund", -5)).rejects.toMatchObject({ code: "23514" });
    await expect(apply(ws.id, "grant", 0)).rejects.toThrow(/non-zero/);
  });

  it("keeps the balance equal to the sum of the ledger", async () => {
    await apply(ws.id, "grant", 100, "top-up");
    await apply(ws.id, "refund", 5, "failed render");
    await apply(ws.id, "adjustment", -3, "correction");
    expect(await balance(ws.id)).toBe(await ledgerSum(ws.id));
  });

  it("does not overdraw under concurrent consumption", async () => {
    const o = await createUser();
    const w = await createWorkspace(o, "Race WS"); // 50 credits
    const attempts = Array.from({ length: 20 }, (_, i) => apply(w.id, "consume", -5, `race ${i}`).then(() => "ok", () => "rejected"));
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === "ok")).toHaveLength(10);
    expect(await balance(w.id)).toBe(0);
    expect(await ledgerSum(w.id)).toBe(0);
  });

  it("ledger is append-only, even for the service role", async () => {
    await expect(asService((q) => q("update public.usage_transactions set amount = 1 where workspace_id = $1", [ws.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asService((q) => q("delete from public.usage_transactions where workspace_id = $1", [ws.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asService((q) => q("delete from public.audit_logs where workspace_id = $1", [ws.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("clients cannot call the internal ledger function", async () => {
    await expect(
      asUser(owner, (q) => q("select public.apply_credit_transaction($1, 'grant', 1000000, 'self-grant')", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("members can read their own ledger", async () => {
    const { rows } = await asUser(owner, (q) => q("select count(*)::int as n from public.usage_transactions where workspace_id = $1", [ws.id]));
    expect(rows[0].n).toBeGreaterThan(1);
  });
});

describe("admin credit adjustments", () => {
  it("non-admins (including workspace owners) are rejected", async () => {
    await expect(
      asUser(owner, (q) => q("select public.admin_adjust_credits($1, 100, 'please')", [ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("platform admins can adjust and the change is ledgered and audited", async () => {
    const staff = await createUser();
    await makePlatformAdmin(staff);
    const before = await balance(ws.id);
    const { rows } = await asUser(staff, (q) => q("select * from public.admin_adjust_credits($1, 25, 'support goodwill')", [ws.id]));
    expect(rows[0]).toMatchObject({ type: "adjustment", amount: 25, balance_after: before + 25, created_by: staff.id });
    const audit = await sql("select actor_id from public.audit_logs where workspace_id = $1 and action = 'credits.adjusted'", [ws.id]);
    expect(audit.rows.at(-1)?.actor_id).toBe(staff.id);
  });

  it("requires a reason", async () => {
    const staff = await createUser();
    await makePlatformAdmin(staff);
    await expect(asUser(staff, (q) => q("select public.admin_adjust_credits($1, 5, '')", [ws.id]))).rejects.toThrow(/reason/);
  });
});
