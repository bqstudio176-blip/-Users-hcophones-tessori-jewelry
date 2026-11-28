import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { MAX_ASSET_SECONDS, sniffMatchesKind, type MediaKind } from "@/lib/video/media-types";
import { CanceledError, isRetryable, PermanentError } from "@/server/analysis/errors";
import {
  extractAudio,
  makeAudioProxy,
  makeThumbnail,
  makeVideoProxy,
  measureLoudness,
  normaliseImage,
  probe,
  runFfmpeg,
} from "@/server/analysis/media/ffmpeg";
import type { MediaStore } from "@/server/analysis/storage";
import type { TranscriptionProvider } from "@/server/analysis/transcription/types";
import { buildAss, toSrt } from "./captions";
import { evaluateChecks, voiceGaps, type RenderStats } from "./checks";
import { buildRenderPlan, type LocalAsset } from "./compose";
import { VIDEO_JOB_STEPS } from "./steps";
import { sceneStarts, scriptDeviation, Timeline, timelineAssetIds, type Word } from "./timeline";

export { VIDEO_JOB_STEPS };

/**
 * Video Studio worker jobs: asset processing, voiceover transcription and
 * rendering. Claimed from public.video_jobs with SKIP LOCKED; progress is
 * reported per step via heartbeats (no invented percentages).
 */
export interface VideoJob {
  id: string;
  workspace_id: string;
  kind: "asset" | "voiceover" | "render";
  asset_id: string | null;
  voiceover_id: string | null;
  render_id: string | null;
  attempts: number;
  max_attempts: number;
}

export interface VideoWorkerDeps {
  pool: Pool;
  store: MediaStore;
  transcriber: TranscriptionProvider | null;
  workerId: string;
  tmpRoot?: string;
  fontsDir?: string | null;
  /** Seconds between heartbeats while ffmpeg is encoding. */
  heartbeatSeconds?: number;
}

export type VideoJobOutcome = "succeeded" | "failed" | "retry_scheduled" | "canceled" | "deferred";



type StepState = { step: string; status: "pending" | "running" | "done" | "skipped" | "failed"; started_at?: string; finished_at?: string; detail?: string };

class Deferred extends Error {
  constructor(public seconds: number) {
    super("deferred");
  }
}

interface Ctx {
  job: VideoJob;
  deps: VideoWorkerDeps;
  tmp: string;
  steps: StepState[];
}

async function heartbeat(c: Ctx, step: string): Promise<boolean> {
  const { rows } = await c.deps.pool.query("select public.heartbeat_video_job($1, $2, $3, $4) as cancel", [c.job.id, c.deps.workerId, step, JSON.stringify(c.steps)]);
  return rows[0].cancel === true;
}

async function runStep(c: Ctx, id: string, fn: () => Promise<string | void>) {
  const s = c.steps.find((x) => x.step === id)!;
  if (await heartbeat(c, id)) throw new CanceledError();
  s.status = "running";
  s.started_at = new Date().toISOString();
  await heartbeat(c, id);
  try {
    const detail = await fn();
    s.status = detail === "skipped" ? "skipped" : "done";
    if (detail && detail !== "skipped") s.detail = detail.slice(0, 300);
  } catch (e) {
    s.status = "failed";
    s.detail = e instanceof Error ? e.message.slice(0, 300) : "error";
    throw e;
  } finally {
    s.finished_at = new Date().toISOString();
    await heartbeat(c, id).catch(() => undefined);
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

async function head(file: string, n = 16): Promise<Uint8Array> {
  const fh = await open(file, "r");
  try {
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    return new Uint8Array(buf);
  } finally {
    await fh.close();
  }
}

const inWorkspace = (c: Ctx, p: string) => {
  if (!p.startsWith(`${c.job.workspace_id}/`)) throw new PermanentError("Media path is outside the workspace");
  return p;
};

// ---------------------------------------------------------------------------
// Asset processing
// ---------------------------------------------------------------------------
async function processAsset(c: Ctx) {
  const { rows } = await c.deps.pool.query("select id, workspace_id, kind, storage_path, status from public.media_assets where id = $1 and workspace_id = $2", [c.job.asset_id, c.job.workspace_id]);
  const a = rows[0] as { id: string; kind: MediaKind; storage_path: string; status: string } | undefined;
  if (!a) throw new PermanentError("Asset no longer exists");
  const ext = path.extname(a.storage_path).toLowerCase() || ".bin";
  const input = path.join(c.tmp, `input${ext}`);
  const base = `${c.job.workspace_id}/assets/${a.id}`;
  let meta: Awaited<ReturnType<typeof probe>> | null = null;

  await runStep(c, "validate", async () => {
    await c.deps.store.download(inWorkspace(c, a.storage_path), input);
    const size = (await stat(input)).size;
    if (size === 0 || size > 1024 ** 3) throw new PermanentError(`File size ${size} bytes is outside the allowed range`);
    if (!sniffMatchesKind(await head(input), a.kind)) throw new PermanentError(`The file content is not a supported ${a.kind} file`);
    const sha = await sha256File(input);
    await c.deps.pool.query("update public.media_assets set sha256 = $2, size_bytes = $3 where id = $1", [a.id, sha, size]);
    return `${Math.round(size / 1024)} KB`;
  });

  await runStep(c, "probe", async () => {
    meta = await probe(input);
    if (a.kind === "video") {
      if (!meta.video) throw new PermanentError("The file has no video stream");
      if (!(meta.durationSeconds > 0)) throw new PermanentError("Could not determine the video duration");
    }
    if (a.kind === "image" && (!meta.video || !meta.video.width)) throw new PermanentError("The file is not a readable image");
    if (a.kind === "audio") {
      if (!meta.audio) throw new PermanentError("The file has no audio stream");
      if (!(meta.durationSeconds > 0)) throw new PermanentError("Could not determine the audio duration");
    }
    if (a.kind !== "image" && meta.durationSeconds > MAX_ASSET_SECONDS) throw new PermanentError(`Media is ${Math.round(meta.durationSeconds)}s; the maximum is ${MAX_ASSET_SECONDS}s`);
    const rotated = meta.video?.rotation && Math.abs(meta.video.rotation) % 180 === 90;
    await c.deps.pool.query(
      "update public.media_assets set metadata = $2, duration_seconds = $3, width = $4, height = $5, has_audio = $6 where id = $1",
      [a.id, JSON.stringify(meta), a.kind === "image" ? null : meta.durationSeconds.toFixed(3), meta.video ? (rotated ? meta.video.height : meta.video.width) : null, meta.video ? (rotated ? meta.video.width : meta.video.height) : null, Boolean(meta.audio)],
    );
    return a.kind === "image" ? `${meta.video!.width}×${meta.video!.height}` : `${meta.durationSeconds.toFixed(1)}s`;
  });

  await runStep(c, "derivatives", async () => {
    const m = meta!;
    let thumb: string | null = null;
    let proxy: string | null = null;
    if (a.kind === "video") {
      const t = path.join(c.tmp, "thumb.jpg");
      await makeThumbnail(input, t, Math.min(1, m.durationSeconds / 2));
      const p = path.join(c.tmp, "proxy.mp4");
      await makeVideoProxy(input, p);
      await c.deps.store.upload(`${base}/thumb.jpg`, t, "image/jpeg");
      await c.deps.store.upload(`${base}/proxy.mp4`, p, "video/mp4");
      thumb = `${base}/thumb.jpg`;
      proxy = `${base}/proxy.mp4`;
    } else if (a.kind === "image") {
      const n = path.join(c.tmp, "proxy.jpg");
      await normaliseImage(input, n);
      const t = path.join(c.tmp, "thumb.jpg");
      await makeThumbnail(n, t, null);
      await c.deps.store.upload(`${base}/proxy.jpg`, n, "image/jpeg");
      await c.deps.store.upload(`${base}/thumb.jpg`, t, "image/jpeg");
      thumb = `${base}/thumb.jpg`;
      proxy = `${base}/proxy.jpg`;
    } else {
      const p = path.join(c.tmp, "proxy.m4a");
      await makeAudioProxy(input, p);
      await c.deps.store.upload(`${base}/proxy.m4a`, p, "audio/mp4");
      proxy = `${base}/proxy.m4a`;
    }
    await c.deps.pool.query("update public.media_assets set thumbnail_path = $2, proxy_path = $3 where id = $1", [a.id, thumb, proxy]);
    return "preview ready";
  });
}

// ---------------------------------------------------------------------------
// Voiceover transcription
// ---------------------------------------------------------------------------
async function processVoiceover(c: Ctx) {
  const { rows } = await c.deps.pool.query(
    `select t.id, t.scene_key, t.project_id, a.id as asset_id, a.status as asset_status, a.storage_path, a.proxy_path, a.has_audio, p.timeline
     from public.voiceover_takes t join public.media_assets a on a.id = t.asset_id join public.video_projects p on p.id = t.project_id
     where t.id = $1 and t.workspace_id = $2`,
    [c.job.voiceover_id, c.job.workspace_id],
  );
  const take = rows[0] as { id: string; scene_key: string | null; asset_status: string; storage_path: string; proxy_path: string | null; has_audio: boolean | null; timeline: unknown } | undefined;
  if (!take) throw new PermanentError("Voiceover take no longer exists");
  if (take.asset_status === "processing" || take.asset_status === "pending_upload") throw new Deferred(10);
  if (take.asset_status !== "ready") throw new PermanentError("The recording could not be processed");
  if (take.has_audio === false) throw new PermanentError("The recording has no audio");

  const audio = path.join(c.tmp, "voice.mp3");
  await runStep(c, "prepare", async () => {
    const src = take.proxy_path ?? take.storage_path;
    const local = path.join(c.tmp, `src${path.extname(src) || ".bin"}`);
    await c.deps.store.download(inWorkspace(c, src), local);
    await extractAudio(local, audio);
    return "audio extracted";
  });

  let words: Word[] = [];
  let text = "";
  let available = true;
  await runStep(c, "transcribe", async () => {
    if (!c.deps.transcriber) {
      available = false;
      await c.deps.pool.query("update public.voiceover_takes set status = 'unavailable', error = $2 where id = $1", [take.id, "Transcription is not configured (OPENAI_API_KEY); captions will use estimated timing."]);
      return "skipped";
    }
    const r = await c.deps.transcriber.transcribe(audio, { wordTimestamps: true });
    words = (r.words ?? []).map((w) => ({ start: w.startMs / 1000, end: w.endMs / 1000, text: w.text })).filter((w) => w.text);
    text = r.text;
    await c.deps.pool.query("update public.voiceover_takes set transcript = $2 where id = $1", [take.id, JSON.stringify({ provider: r.provider, model: r.model, language: r.language, text: r.text, words })]);
    return `${words.length} words`;
  });

  await runStep(c, "compare", async () => {
    if (!available) return "skipped";
    const parsed = Timeline.safeParse(take.timeline);
    const scenes = parsed.success ? parsed.data.scenes : [];
    const script = take.scene_key ? (scenes.find((s) => s.id === take.scene_key)?.spoken_text ?? "") : scenes.map((s) => s.spoken_text).join(" ");
    const dev = scriptDeviation(script, text);
    await c.deps.pool.query("update public.voiceover_takes set deviation = $2 where id = $1", [take.id, JSON.stringify(dev)]);
    return `${Math.round(dev.similarity * 100)}% match`;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
async function processRender(c: Ctx) {
  const { rows } = await c.deps.pool.query(
    `select r.id, r.kind, r.timeline, r.project_id, p.script_id, p.script_version, p.script_snapshot, s.current_version as script_current_version
     from public.video_renders r join public.video_projects p on p.id = r.project_id left join public.scripts s on s.id = p.script_id
     where r.id = $1 and r.workspace_id = $2`,
    [c.job.render_id, c.job.workspace_id],
  );
  const r = rows[0] as { id: string; kind: "draft" | "final"; timeline: unknown; project_id: string; script_version: number | null; script_snapshot: { target_duration_seconds?: number } | null; script_current_version: number | null } | undefined;
  if (!r) throw new PermanentError("Render no longer exists");
  const parsed = Timeline.safeParse(r.timeline);
  if (!parsed.success) throw new PermanentError("The timeline snapshot is invalid");
  const t = parsed.data;
  const local = new Map<string, LocalAsset>();
  const out = path.join(c.tmp, "video.mp4");
  let assFile: string | null = null;
  let args: string[] = [];
  let total = 0;

  await runStep(c, "prepare", async () => {
    const ids = timelineAssetIds(t);
    if (!ids.length) return "no media";
    const { rows: assets } = await c.deps.pool.query(
      "select id, kind, status, storage_path, proxy_path, has_audio, duration_seconds from public.media_assets where workspace_id = $1 and id = any($2::uuid[])",
      [c.job.workspace_id, ids],
    );
    for (const id of ids) {
      const a = assets.find((x) => x.id === id);
      if (!a || a.status !== "ready") throw new PermanentError("A media file used by the timeline is missing or not ready");
      const src: string = a.kind === "image" && a.proxy_path ? a.proxy_path : a.storage_path;
      const file = path.join(c.tmp, `asset-${id}${path.extname(src) || ".bin"}`);
      await c.deps.store.download(inWorkspace(c, src), file);
      local.set(id, { file, kind: a.kind, hasAudio: Boolean(a.has_audio), durationSeconds: a.duration_seconds === null ? null : Number(a.duration_seconds) });
    }
    return `${ids.length} media file(s)`;
  });

  await runStep(c, "compose", async () => {
    const needsAss = r.kind === "draft" || t.scenes.some((s) => s.text?.content.trim()) || (t.captions.enabled && t.captions.burn_in && t.captions.lines.length > 0);
    if (needsAss) {
      assFile = path.join(c.tmp, "overlay.ass");
      await writeFile(assFile, buildAss(t, { watermark: r.kind === "draft" ? "DRAFT" : null }), "utf8");
    }
    const plan = buildRenderPlan({ timeline: t, assets: local, kind: r.kind, assFile, fontsDir: c.deps.fontsDir ?? null, output: out });
    args = plan.args;
    total = plan.totalSeconds;
    return `${t.scenes.length} scenes, ${total.toFixed(1)}s, ${plan.width}×${plan.height}`;
  });

  await runStep(c, "encode", async () => {
    // Keep heart-beating while ffmpeg runs; abort it if the user cancels.
    const controller = new AbortController();
    let canceled = false;
    const timer = setInterval(() => {
      heartbeat(c, "encode")
        .then((cancel) => {
          if (cancel) {
            canceled = true;
            controller.abort();
          }
        })
        .catch(() => undefined);
    }, (c.deps.heartbeatSeconds ?? 5) * 1000);
    try {
      await runFfmpeg(args, { timeoutMs: Math.max(180_000, Math.ceil(total * 30_000)), signal: controller.signal });
    } catch (e) {
      if (canceled) throw new CanceledError();
      throw e;
    } finally {
      clearInterval(timer);
    }
    return "encoded";
  });

  let stats: RenderStats | null = null;
  await runStep(c, "verify", async () => {
    const m = await probe(out);
    const loud = await measureLoudness(out);
    stats = {
      durationSeconds: m.durationSeconds,
      width: m.video?.width ?? 0,
      height: m.video?.height ?? 0,
      videoCodec: m.video?.codec ?? null,
      audioCodec: m.audio?.codec ?? null,
      fps: m.video?.fps ?? null,
      bitRate: m.bitRate,
      integratedLufs: loud.integratedLufs,
      truePeakDb: loud.truePeakDb,
    };
    const gaps = await voiceoverGaps(c, t);
    const checks = evaluateChecks({
      timeline: t,
      kind: r.kind,
      stats,
      targetSeconds: r.script_snapshot?.target_duration_seconds ?? null,
      scriptChanged: r.script_current_version !== null && r.script_version !== null && r.script_current_version > r.script_version,
      gaps,
    });
    await c.deps.pool.query("update public.video_renders set stats = $2, checks = $3 where id = $1", [r.id, JSON.stringify({ ...stats, sizeBytes: m.sizeBytes }), JSON.stringify(checks)]);
    return `checks: ${checks.overall}`;
  });

  await runStep(c, "upload", async () => {
    const base = `${c.job.workspace_id}/renders/${r.id}`;
    await c.deps.store.upload(`${base}/video.mp4`, out, "video/mp4");
    let srt: string | null = null;
    if (t.captions.enabled && t.captions.lines.length) {
      const file = path.join(c.tmp, "captions.srt");
      await writeFile(file, toSrt(t.captions.lines), "utf8");
      await c.deps.store.upload(`${base}/captions.srt`, file, "text/plain");
      srt = `${base}/captions.srt`;
    }
    await c.deps.pool.query("update public.video_renders set output_path = $2, srt_path = $3 where id = $1", [r.id, `${base}/video.mp4`, srt]);
    return srt ? "video + captions saved" : "video saved";
  });
}

/** Long silences inside the voiceover(s) used by this timeline, in video time. */
async function voiceoverGaps(c: Ctx, t: Timeline): Promise<{ from: number; to: number }[]> {
  const takes: { id: string; offset: number }[] = [];
  if (t.voiceover?.take_id) takes.push({ id: t.voiceover.take_id, offset: t.voiceover.offset });
  const starts = sceneStarts(t);
  t.scenes.forEach((s, i) => s.voice?.take_id && takes.push({ id: s.voice.take_id, offset: starts[i]! }));
  if (!takes.length) return [];
  const { rows } = await c.deps.pool.query("select id, transcript from public.voiceover_takes where workspace_id = $1 and id = any($2::uuid[])", [c.job.workspace_id, takes.map((x) => x.id)]);
  return takes.flatMap((tk) => {
    const words = (rows.find((r) => r.id === tk.id)?.transcript?.words ?? []) as Word[];
    return voiceGaps(words, tk.offset);
  });
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------
export async function claimVideoJob(pool: Pool, workerId: string): Promise<VideoJob | null> {
  const { rows } = await pool.query("select id, workspace_id, kind, asset_id, voiceover_id, render_id, attempts, max_attempts from public.claim_video_job($1)", [workerId]);
  return rows[0] ?? null;
}

export async function processVideoJob(job: VideoJob, deps: VideoWorkerDeps): Promise<VideoJobOutcome> {
  const tmp = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "cos-video-"));
  const c: Ctx = { job, deps, tmp, steps: VIDEO_JOB_STEPS[job.kind].map((s) => ({ step: s.id, status: "pending" })) };
  try {
    if (job.attempts > job.max_attempts) throw new PermanentError("Maximum attempts exceeded");
    if (job.kind === "asset") await processAsset(c);
    else if (job.kind === "voiceover") await processVoiceover(c);
    else await processRender(c);
    await deps.pool.query("select public.finish_video_job($1, $2)", [job.id, deps.workerId]);
    return "succeeded";
  } catch (err) {
    if (err instanceof Deferred) {
      await deps.pool.query("select public.defer_video_job($1, $2, $3)", [job.id, deps.workerId, err.seconds]);
      return "deferred";
    }
    if (err instanceof CanceledError) {
      await deps.pool.query("select public.cancel_running_video_job($1, $2)", [job.id, deps.workerId]);
      return "canceled";
    }
    const message = err instanceof Error ? err.message : String(err);
    await heartbeat(c, "failed").catch(() => undefined);
    const backoff = Math.min(30 * 2 ** Math.max(0, job.attempts - 1), 15 * 60);
    const { rows } = await deps.pool.query("select public.fail_video_job($1, $2, $3, $4, $5) as r", [job.id, deps.workerId, message, isRetryable(err), backoff]);
    return rows[0].r as VideoJobOutcome;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
