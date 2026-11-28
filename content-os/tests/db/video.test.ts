import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asAnon, asService, asUser, createUser, createWorkspace, creditBalance, pool, sql, upgradePlan, addMember, type TestUser } from "./helpers";
import { createScript, createVideo, markReady, projectRow, uploadAsset, withVisual } from "./video-helpers";

/**
 * Video Studio database layer: uploads and quotas, projects and versioned
 * timelines, renders and credits, readiness gating, worker-only functions and
 * workspace isolation — all through the real RPCs, RLS and grants.
 */
let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: { id: string };
let other: { id: string };

beforeAll(async () => {
  owner = await createUser();
  member = await createUser();
  outsider = await createUser();
  ws = await createWorkspace(owner, "Video WS");
  await upgradePlan(ws.id);
  await addMember(ws.id, owner, member, "member");
  other = await createWorkspace(outsider, "Other WS");
  await sql("select public.apply_credit_transaction($1, 'grant', 500, 'test top-up')", [ws.id]);
});
afterAll(() => pool.end());

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    return (e as { code?: string }).code ?? "error";
  }
};

describe("media uploads", () => {
  it("requires a rights confirmation, a supported type for the kind and at most 1 GB", async () => {
    const call = (kind: string, mime: string, size: number, rights: boolean) =>
      asUser(member, (q) => q("select public.begin_media_upload($1, $2, $3, $4, 'x', $5)", [ws.id, kind, mime, size, rights]));
    expect(await code(call("video", "video/mp4", 100, false))).toBe("22023");
    expect(await code(call("image", "video/mp4", 100, true))).toBe("22023");
    expect(await code(call("audio", "application/x-sh", 100, true))).toBe("22023");
    expect(await code(call("video", "video/mp4", 1024 ** 3 + 1, true))).toBe("22023");
    expect(await code(call("audio", "audio/webm", 100, true))).toBe("ok");
  });

  it("enforces the plan storage quota", async () => {
    const free = await createWorkspace(owner, "Free WS"); // free plan: 2 GB
    const big = 1000 * 1024 ** 2;
    await uploadAsset(owner, free.id, "video", { size: big });
    await uploadAsset(owner, free.id, "video", { size: big });
    const r = await code(asUser(owner, (q) => q("select public.begin_media_upload($1, 'video', 'video/mp4', $2, 'x', true)", [free.id, big])));
    expect(r).toBe("54000");
    // Failed assets do not count against the quota.
    await sql("update public.media_assets set status = 'failed' where workspace_id = $1", [free.id]);
    expect(await code(asUser(owner, (q) => q("select public.begin_media_upload($1, 'video', 'video/mp4', $2, 'x', true)", [free.id, big])))).toBe("ok");
  });

  it("uploads only to the reserved path, queues processing and keeps server fields read-only", async () => {
    const a = await uploadAsset(member, ws.id, "video");
    const { rows } = await sql("select status from public.media_assets where id = $1", [a.id]);
    expect(rows[0].status).toBe("processing");
    const jobs = await sql("select kind, status from public.video_jobs where asset_id = $1", [a.id]);
    expect(jobs.rows).toEqual([{ kind: "asset", status: "queued" }]);
    // Arbitrary paths in the workspace folder are refused by storage RLS.
    expect(await code(asUser(member, (q) => q("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, '{}')", [`${ws.id}/assets/${a.id}/evil.mp4`, member.id])))).toBe("42501");
    // Clients cannot insert assets or flip their status.
    expect(await code(asUser(member, (q) => q("insert into public.media_assets (workspace_id, kind, title, storage_path, mime, size_bytes, rights_confirmed_at) values ($1, 'video', 'x', 'p', 'video/mp4', 1, now())", [ws.id])))).toBe("42501");
    expect(await code(asUser(member, (q) => q("update public.media_assets set status = 'ready' where id = $1", [a.id])))).toBe("42501");
    await asUser(member, (q) => q("update public.media_assets set title = 'Renamed', tags = '{broll}' where id = $1", [a.id]));
    expect((await sql("select title from public.media_assets where id = $1", [a.id])).rows[0].title).toBe("Renamed");
  });

  it("outsiders cannot upload to, read or process another workspace's media", async () => {
    expect(await code(asUser(outsider, (q) => q("select public.begin_media_upload($1, 'video', 'video/mp4', 10, 'x', true)", [ws.id])))).toBe("42501");
    const a = await uploadAsset(owner, ws.id, "image");
    const seen = await asUser(outsider, (q) => q("select id from public.media_assets where id = $1", [a.id]));
    expect(seen.rowCount).toBe(0);
    expect(await code(asUser(outsider, (q) => q("select public.complete_media_upload($1)", [a.id])))).toBe("P0002");
    expect((await asAnon((q) => q("select count(*)::int as n from public.media_assets").catch(() => ({ rows: [{ n: -1 }] })))).rows[0].n).toBeLessThanOrEqual(0);
  });
});

describe("projects and timelines", () => {
  let scriptId: string;
  let video: Awaited<ReturnType<typeof createVideo>>;
  let clip: string;

  beforeAll(async () => {
    scriptId = await createScript(owner, ws.id);
    video = await createVideo(member, scriptId);
    clip = (await uploadAsset(member, ws.id, "video")).id;
    await markReady(clip);
  });

  it("creates a project from a script with a snapshot and version 1", async () => {
    const p = await projectRow(video.id);
    expect(p.script_version).toBe(1);
    expect(p.script_snapshot.scenes).toHaveLength(3);
    expect(p.timeline.scenes[0].text.content).toBe("Wait!");
    const v = await sql("select version, source from public.video_timeline_versions where project_id = $1", [video.id]);
    expect(v.rows).toEqual([{ version: 1, source: "created" }]);
    // Scripts from another workspace cannot be used.
    const foreign = await createScript(outsider, other.id);
    expect(await code(asUser(member, (q) => q("select public.create_video_project($1, null, 'vertical', $2)", [foreign, JSON.stringify(video.timeline)])))).toBe("P0002");
  });

  it("saves with optimistic concurrency and records which assets are used", async () => {
    const t = withVisual(video.timeline, clip);
    const { rows } = await asUser(member, (q) => q("select public.save_video_timeline($1, $2, 1, true, 'first cut') as v", [video.id, JSON.stringify(t)]));
    expect(rows[0].v).toBe(2);
    expect(await code(asUser(owner, (q) => q("select public.save_video_timeline($1, $2, 1)", [video.id, JSON.stringify(t)])))).toBe("40001");
    const links = await sql("select asset_id from public.video_project_assets where project_id = $1", [video.id]);
    expect(links.rows.map((r) => r.asset_id)).toEqual([clip]);
    // Used media cannot be deleted.
    const del = await asUser(member, (q) => q("delete from public.media_assets where id = $1", [clip]));
    expect(del.rowCount).toBe(0);
  });

  it("rejects timelines with foreign, unready or malformed media and over-long videos", async () => {
    const foreign = (await uploadAsset(outsider, other.id, "video")).id;
    await markReady(foreign);
    const pending = (await uploadAsset(member, ws.id, "video")).id;
    const v = (await projectRow(video.id)).timeline_version;
    const save = (t: unknown) => code(asUser(member, (q) => q("select public.save_video_timeline($1, $2, $3)", [video.id, JSON.stringify(t), v])));
    expect(await save(withVisual(video.timeline, foreign))).toBe("22023");
    expect(await save(withVisual(video.timeline, pending))).toBe("22023");
    expect(await save({ ...video.timeline, scenes: [] })).toBe("22023");
    expect(await save({ ...video.timeline, scenes: video.timeline.scenes.map((s) => ({ ...s, visual: { asset_id: "not-a-uuid" } })) })).toBe("22023");
    expect(await save({ ...video.timeline, scenes: Array.from({ length: 4 }, (_, i) => ({ ...video.timeline.scenes[0], id: `x${i}`, duration: 50 })) })).toBe("22023");
  });

  it("restores versions reversibly and keeps history append-only", async () => {
    const { rows: versions } = await sql("select id from public.video_timeline_versions where project_id = $1 and source = 'created'", [video.id]);
    await asUser(member, (q) => q("select public.restore_video_timeline($1, $2)", [video.id, versions[0].id]));
    const p = await projectRow(video.id);
    expect(p.timeline.scenes[0].visual).toBeNull();
    const sources = (await sql("select source from public.video_timeline_versions where project_id = $1 order by created_at", [video.id])).rows.map((r) => r.source);
    expect(sources).toEqual(expect.arrayContaining(["created", "manual", "before_restore", "restored"]));
    expect(await code(asService((q) => q("update public.video_timeline_versions set note = 'x' where project_id = $1", [video.id])))).toBe("42501");
    expect(await code(asService((q) => q("delete from public.video_timeline_versions where project_id = $1", [video.id])))).toBe("42501");
  });

  it("only exposes title for direct edits; status changes go through RPCs", async () => {
    expect(await code(asUser(member, (q) => q("update public.video_projects set status = 'ready' where id = $1", [video.id])))).toBe("42501");
    await asUser(member, (q) => q("update public.video_projects set title = 'My reel' where id = $1", [video.id]));
    await asUser(member, (q) => q("select public.set_video_project_archived($1, true)", [video.id]));
    expect((await projectRow(video.id)).status).toBe("archived");
    expect(await code(asUser(member, (q) => q("select public.request_render($1, 'draft')", [video.id])))).toBe("22023");
    await asUser(member, (q) => q("select public.set_video_project_archived($1, false)", [video.id]));
  });
});

describe("renders, credits and readiness", () => {
  let videoId: string;
  let clip: string;

  beforeAll(async () => {
    const scriptId = await createScript(owner, ws.id);
    const v = await createVideo(owner, scriptId);
    videoId = v.id;
    clip = (await uploadAsset(owner, ws.id, "video")).id;
    await markReady(clip);
    await asUser(owner, (q) => q("select public.save_video_timeline($1, $2, 1)", [videoId, JSON.stringify(withVisual(v.timeline, clip))]));
  });

  const cleanup = () => sql("update public.video_renders set status = 'canceled' where project_id = $1 and status in ('queued','processing')", [videoId]);

  it("final renders charge credits by duration; drafts are free; one active render per video", async () => {
    const before = await creditBalance(ws.id);
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    const r = (await sql("select credits_charged, duration_seconds, status from public.video_renders where id = $1", [rows[0].id])).rows[0];
    expect(r.credits_charged).toBe(3);
    expect(Number(r.duration_seconds)).toBe(6);
    expect(await creditBalance(ws.id)).toBe(before - 3);
    expect(await code(asUser(owner, (q) => q("select public.request_render($1, 'draft')", [videoId])))).toBe("22023");
    // Cancel while queued → refunded once.
    await asUser(owner, (q) => q("select public.cancel_render($1)", [rows[0].id]));
    expect(await creditBalance(ws.id)).toBe(before);
    const { rows: d } = await asUser(owner, (q) => q("select public.request_render($1, 'draft') as id", [videoId]));
    expect((await sql("select credits_charged from public.video_renders where id = $1", [d[0].id])).rows[0].credits_charged).toBe(0);
    expect(await creditBalance(ws.id)).toBe(before);
    await cleanup();
  });

  it("is idempotent and rolls back completely without enough credits", async () => {
    const key = `k-${Date.now()}`;
    const a = await asUser(owner, (q) => q("select public.request_render($1, 'draft', $2) as id", [videoId, key]));
    const b = await asUser(owner, (q) => q("select public.request_render($1, 'draft', $2) as id", [videoId, key]));
    expect(b.rows[0].id).toBe(a.rows[0].id);
    await cleanup();
    const poor = await createWorkspace(member, "Poor WS");
    const scriptId = await createScript(member, poor.id);
    const v = await createVideo(member, scriptId);
    const balance = await creditBalance(poor.id);
    await sql("select public.apply_credit_transaction($1, 'consume', $2, 'drain')", [poor.id, -balance]);
    expect(await code(asUser(member, (q) => q("select public.request_render($1, 'final')", [v.id])))).toBe("P0001");
    expect((await sql("select count(*)::int as n from public.video_renders where project_id = $1", [v.id])).rows[0].n).toBe(0);
    expect((await sql("select count(*)::int as n from public.video_jobs where workspace_id = $1 and kind = 'render'", [poor.id])).rows[0].n).toBe(0);
  });

  it("limits draft renders per hour", async () => {
    await sql("update public.media_storage_limits set draft_renders_per_hour = 0 where plan_id = 'studio'");
    try {
      expect(await code(asUser(owner, (q) => q("select public.request_render($1, 'draft')", [videoId])))).toBe("54000");
    } finally {
      await sql("update public.media_storage_limits set draft_renders_per_hour = 10 where plan_id = 'studio'");
    }
  });

  it("worker functions are service-role only; failures refund exactly once", async () => {
    expect(await code(asUser(owner, (q) => q("select * from public.claim_video_job('evil')")))).toBe("42501");
    const before = await creditBalance(ws.id);
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    await sql("update public.video_jobs set max_attempts = 1, run_after = now() - interval '1 hour' where render_id = $1", [rows[0].id]);
    const job = (await sql("select id from public.video_jobs where render_id = $1", [rows[0].id])).rows[0];
    await sql("update public.video_jobs set status = 'canceled' where status = 'queued' and id <> $1", [job.id]);
    const claimed = await asService((q) => q("select * from public.claim_video_job('w1')"));
    expect(claimed.rows[0].id).toBe(job.id);
    expect((await sql("select status from public.video_renders where id = $1", [rows[0].id])).rows[0].status).toBe("processing");
    expect(await code(asService((q) => q("select public.finish_video_job($1, 'someone-else')", [job.id])))).toBe("55000");
    await asService((q) => q("select public.fail_video_job($1, 'w1', 'boom', true)", [job.id]));
    expect((await sql("select status, credits_refunded from public.video_renders where id = $1", [rows[0].id])).rows[0]).toEqual({ status: "failed", credits_refunded: true });
    expect(await creditBalance(ws.id)).toBe(before);
    await asService((q) => q("select public.refund_render_credits($1)", [rows[0].id]));
    expect(await creditBalance(ws.id)).toBe(before);
  });

  it("marks ready only from a completed final render of the current timeline with no failing checks", async () => {
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    const id = rows[0].id;
    const ready = () => code(asUser(owner, (q) => q("select public.mark_video_ready($1, $2)", [videoId, id])));
    expect(await ready()).toBe("22023"); // still queued
    await sql("update public.video_renders set status = 'completed', checks = '{\"overall\":\"fail\",\"items\":[]}' where id = $1", [id]);
    await sql("update public.video_jobs set status = 'succeeded' where render_id = $1", [id]);
    expect(await ready()).toBe("22023");
    await sql("update public.video_renders set checks = '{\"overall\":\"warn\",\"items\":[]}' where id = $1", [id]);
    expect(await ready()).toBe("ok");
    expect((await projectRow(videoId)).status).toBe("ready");
    // Editing the timeline puts the video back to draft.
    const p = await projectRow(videoId);
    await asUser(owner, (q) => q("select public.save_video_timeline($1, $2, $3)", [videoId, JSON.stringify(p.timeline), p.timeline_version]));
    const after = await projectRow(videoId);
    expect(after.status).toBe("draft");
    expect(after.ready_render_id).toBeNull();
    expect(await ready()).toBe("22023"); // timeline changed since render
    // Feedback can target renders of this workspace only.
    await asUser(owner, (q) => q("insert into public.script_feedback (workspace_id, target_type, target_id, rating, created_by) values ($1, 'video_render', $2, 'useful', $3)", [ws.id, id, owner.id]));
    expect(await code(asUser(outsider, (q) => q("insert into public.script_feedback (workspace_id, target_type, target_id, rating, created_by) values ($1, 'video_render', $2, 'useful', $3)", [other.id, id, outsider.id])))).toBe("23514");
  });
});

describe("voiceover takes and isolation", () => {
  it("accepts audio/video recordings only and queues transcription", async () => {
    const scriptId = await createScript(owner, ws.id);
    const v = await createVideo(owner, scriptId);
    const img = (await uploadAsset(owner, ws.id, "image")).id;
    await markReady(img);
    expect(await code(asUser(owner, (q) => q("select public.add_voiceover_take($1, $2)", [v.id, img])))).toBe("22023");
    const rec = (await uploadAsset(owner, ws.id, "audio", { mime: "audio/webm" })).id;
    const { rows } = await asUser(owner, (q) => q("select public.add_voiceover_take($1, $2) as id", [v.id, rec]));
    expect((await sql("select kind from public.video_jobs where voiceover_id = $1", [rows[0].id])).rows[0].kind).toBe("voiceover");
    expect(await code(asUser(outsider, (q) => q("select public.add_voiceover_take($1, $2)", [v.id, rec])))).toBe("P0002");
  });

  it("hides every Video Studio table from other workspaces", async () => {
    for (const table of ["media_assets", "video_projects", "video_project_assets", "video_timeline_versions", "voiceover_takes", "video_renders", "video_jobs"]) {
      const { rows } = await asUser(outsider, (q) => q(`select count(*)::int as n from public.${table} where workspace_id = $1`, [ws.id]));
      expect(rows[0].n, table).toBe(0);
    }
    const scriptId = await createScript(owner, ws.id);
    const v = await createVideo(owner, scriptId);
    for (const fn of [`select public.save_video_timeline('${v.id}', '{}'::jsonb, 1)`, `select public.request_render('${v.id}', 'draft')`, `select public.set_video_project_archived('${v.id}', true)`]) {
      expect(await code(asUser(outsider, (q) => q(fn))), fn).toBe("P0002");
    }
  });
});
