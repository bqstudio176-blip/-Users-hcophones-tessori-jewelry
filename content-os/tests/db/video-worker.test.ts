import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { probe } from "@/server/analysis/media/ffmpeg";
import { LocalMediaStore } from "@/server/analysis/storage";
import type { TranscriptionProvider, TranscriptResult } from "@/server/analysis/transcription/types";
import { estimateCaptions } from "@/server/video/captions";
import { Timeline } from "@/server/video/timeline";
import { claimVideoJob, processVideoJob, type VideoWorkerDeps } from "@/server/video/worker";
import { makeFakeVideo } from "../fixtures/media";
import { makeClip, makeImage, makeMusic, makeVoice } from "../fixtures/video-media";
import { asUser, createUser, createWorkspace, creditBalance, pool, sql, upgradePlan, type TestUser } from "./helpers";
import { createScript, createVideo, projectRow, uploadAsset } from "./video-helpers";

/**
 * Video Studio worker on REAL ffmpeg/ffprobe and the REAL Postgres queue,
 * with a local media store and a mock transcriber.
 */
let owner: TestUser;
let ws: { id: string };
let root: string;
let store: LocalMediaStore;
let fx: { clip: string; image: string; voice: string; music: string; fake: string };

class WordsTranscriber implements TranscriptionProvider {
  id = "mock";
  model = "mock-whisper";
  supportsSpeakers = false;
  async transcribe(): Promise<TranscriptResult> {
    const words = ["Stop", "scrolling", "for", "a", "second.", "Here", "is", "the", "one", "idea", "that", "matters.", "Follow", "for", "part", "two."];
    return {
      provider: this.id, model: this.model, language: "en", text: words.join(" "), durationSeconds: 6, segments: [],
      words: words.map((w, i) => ({ startMs: 200 + i * 330, endMs: 200 + i * 330 + 280, text: w })),
    };
  }
}

beforeAll(async () => {
  owner = await createUser();
  ws = await createWorkspace(owner, "Render WS");
  await upgradePlan(ws.id);
  await sql("select public.apply_credit_transaction($1, 'grant', 500, 'test top-up')", [ws.id]);
  const dir = mkdtempSync(path.join(os.tmpdir(), "cos-video-fx-"));
  fx = { clip: makeClip(dir), image: makeImage(dir), voice: makeVoice(dir), music: makeMusic(dir), fake: makeFakeVideo(dir) };
  root = mkdtempSync(path.join(os.tmpdir(), "cos-video-store-"));
  store = new LocalMediaStore(root);
}, 60_000);
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await pool.end();
});
// Only this file's jobs should be claimable.
beforeEach(() => sql("update public.video_jobs set status = 'canceled' where status in ('queued', 'running') and workspace_id <> $1", [ws.id]));

const deps = (over: Partial<VideoWorkerDeps> = {}): VideoWorkerDeps => ({ pool, store, transcriber: new WordsTranscriber(), workerId: "video-test", heartbeatSeconds: 1, ...over });

async function runNext(over: Partial<VideoWorkerDeps> = {}) {
  const job = await claimVideoJob(pool, "video-test");
  expect(job).not.toBeNull();
  return { job: job!, outcome: await processVideoJob(job!, deps(over)) };
}

/** Upload through the real RPCs, place the bytes in the local store, process with the worker. */
async function ingest(kind: "video" | "image" | "audio", file: string, mime?: string) {
  const a = await uploadAsset(owner, ws.id, kind, { mime });
  mkdirSync(path.dirname(path.join(root, a.path)), { recursive: true });
  await copyFile(file, path.join(root, a.path));
  const { outcome } = await runNext();
  return { ...a, outcome };
}

const asset = async (id: string) => (await sql("select * from public.media_assets where id = $1", [id])).rows[0];

describe("asset processing", () => {
  it("probes video, makes a thumbnail and a browser proxy", async () => {
    const a = await ingest("video", fx.clip);
    expect(a.outcome).toBe("succeeded");
    const row = await asset(a.id);
    expect(row.status).toBe("ready");
    expect(Number(row.duration_seconds)).toBeCloseTo(4, 0);
    expect([row.width, row.height, row.has_audio]).toEqual([640, 360, true]);
    expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(path.join(root, row.thumbnail_path))).toBe(true);
    const proxy = await probe(path.join(root, row.proxy_path));
    expect(proxy.video?.codec).toBe("h264");
  });

  it("normalises images and transcodes audio to an AAC proxy", async () => {
    const img = await ingest("image", fx.image);
    expect((await asset(img.id)).proxy_path).toMatch(/proxy\.jpg$/);
    const aud = await ingest("audio", fx.voice);
    const row = await asset(aud.id);
    expect(row.status).toBe("ready");
    expect((await probe(path.join(root, row.proxy_path))).audio?.codec).toBe("aac");
  });

  it("rejects a disguised file without retrying or executing it", async () => {
    const a = await ingest("video", fx.fake);
    expect(a.outcome).toBe("failed");
    const row = await asset(a.id);
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/not a supported video/);
    expect(existsSync("/tmp/pwned")).toBe(false);
  });
});

describe("voiceover transcription", () => {
  let videoId: string;
  let voiceId: string;

  beforeAll(async () => {
    const scriptId = await createScript(owner, ws.id);
    videoId = (await createVideo(owner, scriptId)).id;
    voiceId = (await ingest("audio", fx.voice)).id;
  });

  it("stores word timestamps and how closely the take follows the script", async () => {
    const { rows } = await asUser(owner, (q) => q("select public.add_voiceover_take($1, $2) as id", [videoId, voiceId]));
    expect((await runNext()).outcome).toBe("succeeded");
    const take = (await sql("select status, transcript, deviation from public.voiceover_takes where id = $1", [rows[0].id])).rows[0];
    expect(take.status).toBe("completed");
    expect(take.transcript.words).toHaveLength(16);
    expect(take.deviation.similarity).toBe(1);
  });

  it("marks takes unavailable (not failed) when transcription is not configured", async () => {
    const { rows } = await asUser(owner, (q) => q("select public.add_voiceover_take($1, $2) as id", [videoId, voiceId]));
    expect((await runNext({ transcriber: null })).outcome).toBe("succeeded");
    expect((await sql("select status from public.voiceover_takes where id = $1", [rows[0].id])).rows[0].status).toBe("unavailable");
  });

  it("waits for a recording that is still processing without using up attempts", async () => {
    const pending = await uploadAsset(owner, ws.id, "audio");
    const { rows } = await asUser(owner, (q) => q("select public.add_voiceover_take($1, $2) as id", [videoId, pending.id]));
    // Park the asset job so the voiceover job is claimed first.
    await sql("update public.video_jobs set run_after = now() + interval '1 hour' where asset_id = $1", [pending.id]);
    expect((await runNext()).outcome).toBe("deferred");
    const job = (await sql("select status, attempts from public.video_jobs where voiceover_id = $1", [rows[0].id])).rows[0];
    expect(job).toEqual({ status: "queued", attempts: 0 });
    await sql("update public.video_jobs set status = 'canceled' where voiceover_id = $1 or asset_id = $2", [rows[0].id, pending.id]);
  });
});

describe("rendering", () => {
  let videoId: string;
  let clipId: string;
  let imageId: string;
  let voiceId: string;
  let musicId: string;

  beforeAll(async () => {
    const scriptId = await createScript(owner, ws.id);
    videoId = (await createVideo(owner, scriptId)).id;
    clipId = (await ingest("video", fx.clip)).id;
    imageId = (await ingest("image", fx.image)).id;
    voiceId = (await ingest("audio", fx.voice)).id;
    musicId = (await ingest("audio", fx.music)).id;
    const { rows } = await asUser(owner, (q) => q("select public.add_voiceover_take($1, $2) as id", [videoId, voiceId]));
    await runNext();
    const p = await projectRow(videoId);
    const t = Timeline.parse(p.timeline);
    t.scenes[0]!.visual = { asset_id: clipId, kind: "video", trim_start: 0.5, fit: "fill", focal_x: 0.5, focal_y: 0.3, ken_burns: false, volume: 0.2 };
    t.scenes[0]!.transition = "crossfade";
    t.scenes[1]!.visual = { asset_id: imageId, kind: "image", trim_start: 0, fit: "fit_blur", focal_x: 0.5, focal_y: 0.5, ken_burns: true, volume: 0 };
    t.scenes[2]!.visual = { asset_id: clipId, kind: "video", trim_start: 2, fit: "fit_blur", focal_x: 0.5, focal_y: 0.5, ken_burns: false, volume: 0 };
    t.scenes[2]!.text = { content: "Follow {\\b1}for more", style: "boxed", position: "center" };
    t.voiceover = { asset_id: voiceId, take_id: rows[0].id, volume: 1, offset: 0 };
    t.music = { asset_id: musicId, start: 0, volume: 0.4, fade_in: 0.5, fade_out: 1, duck: true };
    t.captions.lines = estimateCaptions(t);
    t.captions.style = "highlight";
    await asUser(owner, (q) => q("select public.save_video_timeline($1, $2, $3)", [videoId, JSON.stringify(t), p.timeline_version]));
  }, 120_000);

  it("renders a watermarked draft with measured stats and checks", async () => {
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'draft') as id", [videoId]));
    const { outcome, job } = await runNext();
    expect(outcome).toBe("succeeded");
    const r = (await sql("select * from public.video_renders where id = $1", [rows[0].id])).rows[0];
    expect(r.status).toBe("completed");
    expect([r.stats.width, r.stats.height, r.stats.videoCodec, r.stats.audioCodec]).toEqual([540, 960, "h264", "aac"]);
    expect(r.stats.durationSeconds).toBeCloseTo(6, 0);
    expect(r.checks.items.find((i: { id: string }) => i.id === "render_kind").status).toBe("fail");
    expect(existsSync(path.join(root, r.output_path))).toBe(true);
    expect(existsSync(path.join(root, r.srt_path))).toBe(true);
    const steps = (await sql("select steps from public.video_jobs where id = $1", [job.id])).rows[0].steps;
    expect(steps.map((s: { status: string }) => s.status)).toEqual(["done", "done", "done", "done", "done"]);
  }, 120_000);

  it("renders a final 1080×1920 video normalised to about −14 LUFS that can be marked ready", async () => {
    const before = await creditBalance(ws.id);
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    expect(await creditBalance(ws.id)).toBe(before - 3);
    expect((await runNext()).outcome).toBe("succeeded");
    const r = (await sql("select * from public.video_renders where id = $1", [rows[0].id])).rows[0];
    expect([r.stats.width, r.stats.height, r.stats.fps]).toEqual([1080, 1920, 30]);
    expect(r.stats.integratedLufs).toBeGreaterThan(-16.5);
    expect(r.stats.integratedLufs).toBeLessThan(-11.5);
    expect(r.checks.overall).not.toBe("fail");
    const byId = Object.fromEntries(r.checks.items.map((i: { id: string; status: string }) => [i.id, i.status]));
    expect(byId).toMatchObject({ render_kind: "pass", resolution: "pass", codecs: "pass", media: "pass", duration_target: "pass", voice_gaps: "pass" });
    await asUser(owner, (q) => q("select public.mark_video_ready($1, $2)", [videoId, rows[0].id]));
    expect((await projectRow(videoId)).status).toBe("ready");
    expect(await creditBalance(ws.id)).toBe(before - 3); // charged once, not refunded
  }, 180_000);

  it("cancels a running render and refunds it", async () => {
    const before = await creditBalance(ws.id);
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    const job = await claimVideoJob(pool, "video-test");
    expect(await asUser(owner, (q) => q("select public.cancel_render($1) as r", [rows[0].id])).then((x) => x.rows[0].r)).toBe("cancel_requested");
    expect(await processVideoJob(job!, deps())).toBe("canceled");
    expect((await sql("select status, credits_refunded from public.video_renders where id = $1", [rows[0].id])).rows[0]).toEqual({ status: "canceled", credits_refunded: true });
    expect(await creditBalance(ws.id)).toBe(before);
  });

  it("fails cleanly and refunds when media disappears from storage", async () => {
    const before = await creditBalance(ws.id);
    const row = await asset(musicId);
    rmSync(path.join(root, row.storage_path));
    const { rows } = await asUser(owner, (q) => q("select public.request_render($1, 'final') as id", [videoId]));
    await sql("update public.video_jobs set max_attempts = 1 where render_id = $1", [rows[0].id]);
    expect((await runNext()).outcome).toBe("failed");
    const r = (await sql("select status, error, credits_refunded from public.video_renders where id = $1", [rows[0].id])).rows[0];
    expect(r.status).toBe("failed");
    expect(r.credits_refunded).toBe(true);
    expect(await creditBalance(ws.id)).toBe(before);
  });
});
