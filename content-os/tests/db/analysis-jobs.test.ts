import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  asService,
  asUser,
  createReference,
  createUser,
  createWorkspace,
  creditBalance,
  pool,
  sql,
  uploadVideo,
  upgradePlan,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: { id: string };

async function readyReference(user = member) {
  const ref = await createReference(user, ws.id);
  await uploadVideo(user, ref.id);
  return ref;
}
const request = (user: TestUser, refId: string, key: string | null = null) =>
  asUser(user, (q) => q("select public.request_analysis($1, $2) as id", [refId, key])).then((r) => r.rows[0].id as string);
const claim = (worker = "w1") =>
  asService((q) => q("select * from public.claim_analysis_job($1)", [worker])).then((r) => r.rows[0] ?? null);
const status = async (analysisId: string) =>
  (await sql(
    `select a.status as analysis, j.status as job, r.analysis_status as reference, a.credits_refunded as refunded, j.attempts
     from public.video_analyses a join public.analysis_jobs j on j.analysis_id = a.id join public.content_references r on r.id = a.reference_id
     where a.id = $1`,
    [analysisId],
  )).rows[0];

// Drain any queued jobs from other tests so claims are deterministic.
async function drainQueue() {
  await sql("update public.analysis_jobs set status = 'canceled' where status in ('queued','running')");
  await sql("update public.video_analyses set status = 'canceled' where status in ('queued','processing')");
}

beforeAll(async () => {
  owner = await createUser();
  member = await createUser();
  outsider = await createUser();
  ws = await createWorkspace(owner, "Analyze WS");
  await upgradePlan(ws.id);
  await sql("select public.apply_credit_transaction($1, 'grant', 1000, 'test top-up')", [ws.id]);
  await addMember(ws.id, owner, member, "member");
});

afterAll(() => pool.end());

describe("requesting an analysis", () => {
  it("charges credits, queues a job and marks the reference queued", async () => {
    const ref = await readyReference();
    const before = await creditBalance(ws.id);
    const id = await request(member, ref.id);
    expect(await creditBalance(ws.id)).toBe(before - 5);
    expect(await status(id)).toMatchObject({ analysis: "queued", job: "queued", reference: "queued" });
    const audit = await sql("select action from public.audit_logs where entity_id = $1", [id]);
    expect(audit.rows.map((r) => r.action)).toContain("analysis.requested");
  });

  it("requires an uploaded video", async () => {
    const ref = await createReference(member, ws.id);
    await expect(request(member, ref.id)).rejects.toThrow(/upload a video/);
  });

  it("allows only one active analysis per reference, and is idempotent with a key", async () => {
    const ref = await readyReference();
    const a = await request(member, ref.id, "click-1");
    const b = await request(member, ref.id, "click-1");
    expect(b).toBe(a);
    await expect(request(member, ref.id)).rejects.toThrow(/already in progress/);
  });

  it("fails atomically when credits are insufficient", async () => {
    const o = await createUser();
    const poor = await createWorkspace(o, "Poor WS");
    await sql("select public.apply_credit_transaction($1, 'consume', -48, 'drain')", [poor.id]); // 2 left
    const ref = await createReference(o, poor.id);
    await uploadVideo(o, ref.id);
    await expect(request(o, ref.id)).rejects.toThrow(/insufficient credits/);
    const { rows } = await sql("select count(*)::int as n from public.video_analyses where reference_id = $1", [ref.id]);
    expect(rows[0].n).toBe(0);
    expect(await creditBalance(poor.id)).toBe(2);
  });

  it("outsiders cannot request, cancel or read analyses", async () => {
    const ref = await readyReference();
    await expect(request(outsider, ref.id)).rejects.toMatchObject({ code: "P0002" });
    const id = await request(member, ref.id);
    await expect(asUser(outsider, (q) => q("select public.cancel_analysis($1)", [id]))).rejects.toMatchObject({ code: "P0002" });
    for (const t of ["video_analyses", "analysis_jobs"]) {
      const col = t === "video_analyses" ? "id" : "analysis_id";
      const { rows } = await asUser(outsider, (q) => q(`select * from public.${t} where ${col} = $1`, [id]));
      expect(rows).toHaveLength(0);
    }
  });

  it("clients cannot call worker functions or write analysis output", async () => {
    await expect(asUser(owner, (q) => q("select * from public.claim_analysis_job('evil')"))).rejects.toMatchObject({ code: "42501" });
    const ref = await readyReference();
    const id = await request(member, ref.id);
    await expect(
      asUser(owner, (q) => q("insert into public.analysis_reports (analysis_id, workspace_id, sections, model_provider, model_id) values ($1, $2, '{}', 'x', 'y')", [id, ws.id])),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(owner, (q) => q("update public.video_analyses set status = 'completed' where id = $1", [id])),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("cancellation", () => {
  it("cancelling a queued job refunds credits immediately", async () => {
    const ref = await readyReference();
    const before = await creditBalance(ws.id);
    const id = await request(member, ref.id);
    const { rows } = await asUser(member, (q) => q("select public.cancel_analysis($1) as r", [id]));
    expect(rows[0].r).toBe("canceled");
    expect(await creditBalance(ws.id)).toBe(before);
    expect(await status(id)).toMatchObject({ analysis: "canceled", job: "canceled", reference: "not_analyzed", refunded: true });
  });

  it("another member cannot cancel someone else's analysis, but an admin/owner can", async () => {
    const ref = await readyReference(owner);
    const id = await request(owner, ref.id);
    await expect(asUser(member, (q) => q("select public.cancel_analysis($1)", [id]))).rejects.toMatchObject({ code: "42501" });
    const ref2 = await readyReference(member);
    const id2 = await request(member, ref2.id);
    await expect(asUser(owner, (q) => q("select public.cancel_analysis($1)", [id2]))).resolves.toBeTruthy();
  });

  it("cancelling a running job sets a flag the worker honours, then refunds", async () => {
    await drainQueue();
    const ref = await readyReference();
    const id = await request(member, ref.id);
    const job = await claim("w-cancel");
    expect(job.analysis_id).toBe(id);
    expect(await status(id)).toMatchObject({ analysis: "processing", reference: "processing" });
    const { rows } = await asUser(member, (q) => q("select public.cancel_analysis($1) as r", [id]));
    expect(rows[0].r).toBe("cancel_requested");
    const hb = await asService((q) => q("select public.heartbeat_analysis_job($1, 'w-cancel', 'media', '[]') as c", [job.id]));
    expect(hb.rows[0].c).toBe(true);
    await asService((q) => q("select public.cancel_running_analysis_job($1, 'w-cancel')", [job.id]));
    expect(await status(id)).toMatchObject({ analysis: "canceled", job: "canceled", refunded: true });
  });
});

describe("worker queue", () => {
  it("claims a job once even with concurrent workers (SKIP LOCKED)", async () => {
    await drainQueue();
    const ref = await readyReference();
    await request(member, ref.id);
    const claims = await Promise.all(Array.from({ length: 5 }, (_, i) => claim(`w${i}`)));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("finishing marks analysis completed and the reference analyzed", async () => {
    await drainQueue();
    const ref = await readyReference();
    const id = await request(member, ref.id);
    const job = await claim("w-ok");
    await asService((q) => q("select public.finish_analysis_job($1, 'w-ok')", [job.id]));
    expect(await status(id)).toMatchObject({ analysis: "completed", job: "succeeded", reference: "analyzed", refunded: false });
  });

  it("a worker cannot finish a job it does not hold", async () => {
    await drainQueue();
    const ref = await readyReference();
    await request(member, ref.id);
    const job = await claim("w-real");
    await expect(asService((q) => q("select public.finish_analysis_job($1, 'w-impostor')", [job.id]))).rejects.toMatchObject({ code: "55000" });
  });

  it("retryable failures are re-queued with backoff until max_attempts, then fail and refund", async () => {
    await drainQueue();
    const ref = await readyReference();
    const before = await creditBalance(ws.id);
    const id = await request(member, ref.id);
    for (let attempt = 1; attempt <= 3; attempt++) {
      await sql("update public.analysis_jobs set run_after = now() where analysis_id = $1", [id]); // skip backoff in test
      const job = await claim("w-retry");
      expect(job.attempts).toBe(attempt);
      const r = await asService((q) => q("select public.fail_analysis_job($1, 'w-retry', 'transcription timeout', true, 30) as r", [job.id]));
      expect(r.rows[0].r).toBe(attempt < 3 ? "retry_scheduled" : "failed");
      if (attempt < 3) {
        const { rows } = await sql("select run_after > now() as later from public.analysis_jobs where id = $1", [job.id]);
        expect(rows[0].later).toBe(true);
      }
    }
    expect(await status(id)).toMatchObject({ analysis: "failed", job: "failed", reference: "failed", refunded: true });
    expect(await creditBalance(ws.id)).toBe(before);
  });

  it("permanent failures fail immediately and refund once", async () => {
    await drainQueue();
    const ref = await readyReference();
    const before = await creditBalance(ws.id);
    const id = await request(member, ref.id);
    const job = await claim("w-perm");
    await asService((q) => q("select public.fail_analysis_job($1, 'w-perm', 'not a video file', false)", [job.id]));
    await asService((q) => q("select public.refund_analysis_credits($1)", [id])); // second refund is a no-op
    expect(await status(id)).toMatchObject({ analysis: "failed", refunded: true });
    expect(await creditBalance(ws.id)).toBe(before);
  });

  it("reclaims a running job whose worker stopped heart-beating", async () => {
    await drainQueue();
    const ref = await readyReference();
    await request(member, ref.id);
    const job = await claim("w-crashed");
    await sql("update public.analysis_jobs set heartbeat_at = now() - interval '11 minutes' where id = $1", [job.id]);
    const again = await claim("w-rescuer");
    expect(again.id).toBe(job.id);
    expect(again.locked_by).toBe("w-rescuer");
    expect(again.attempts).toBe(2);
  });

  it("references cannot be deleted while an analysis is active", async () => {
    await drainQueue();
    const ref = await readyReference();
    await request(member, ref.id);
    const del = await asUser(member, (q) => q("delete from public.content_references where id = $1", [ref.id]));
    expect(del.rowCount).toBe(0);
  });

  it("members can edit report notes only", async () => {
    await drainQueue();
    const ref = await readyReference();
    const id = await request(member, ref.id);
    await sql("insert into public.analysis_reports (analysis_id, workspace_id, sections, model_provider, model_id) values ($1, $2, '{}', 'anthropic', 'claude-opus-5-5')", [id, ws.id]);
    const ok = await asUser(member, (q) => q("update public.analysis_reports set user_notes = 'mine' where analysis_id = $1", [id]));
    expect(ok.rowCount).toBe(1);
    await expect(asUser(member, (q) => q("update public.analysis_reports set sections = '{\"x\":1}' where analysis_id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    const other = await asUser(outsider, (q) => q("update public.analysis_reports set user_notes = 'x' where analysis_id = $1", [id]));
    expect(other.rowCount).toBe(0);
  });
});
