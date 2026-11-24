import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { sniffVideoContainer } from "@/lib/discover/upload";
import { computeEditingFacts, formatTimestamp, transcriptForScene } from "./align";
import { PROMPT_VERSIONS, SYSTEM_PROMPTS, type PromptPurpose } from "./ai/prompts";
import { InvalidOutputError, RefusalError, type AnalysisModel, type ContentPart } from "./ai/provider";
import {
  checkTimestamps,
  ContentSummary,
  CreativeOpportunities,
  EditingAnalysis,
  HookAnalysis,
  NarrativeAnalysis,
  ReportSections,
  VisionBatch,
  type VisualScene,
} from "./ai/schemas";
import { ANALYSIS_LIMITS, PIPELINE_STEPS, type PipelineStepId } from "./config";
import { CanceledError, isRetryable, PermanentError, RetryableError } from "./errors";
import { detectSceneCuts, extractAudio, extractFrame, probe, type MediaMetadata } from "./media/ffmpeg";
import { buildScenes, selectScenesForVision, type SceneBoundary } from "./media/scenes";
import type { MediaStore } from "./storage";
import type { TranscriptionProvider, TranscriptResult, TranscriptSegment } from "./transcription/types";
import type { z } from "zod";

export interface ClaimedJob {
  id: string;
  workspace_id: string;
  analysis_id: string;
  attempts: number;
  max_attempts: number;
}

export interface PipelineDeps {
  pool: Pool;
  store: MediaStore;
  transcriber: TranscriptionProvider | null;
  model: AnalysisModel | null;
  workerId: string;
  tmpRoot?: string;
  limits?: Partial<typeof ANALYSIS_LIMITS>;
}

type StepState = { step: PipelineStepId; status: "pending" | "running" | "done" | "skipped" | "failed"; started_at?: string; finished_at?: string; detail?: string };
export type JobOutcome = "succeeded" | "failed" | "retry_scheduled" | "canceled";

interface Ctx {
  job: ClaimedJob;
  deps: PipelineDeps;
  limits: typeof ANALYSIS_LIMITS;
  steps: StepState[];
  tmp: string;
  ref: { id: string; workspace_id: string; media_path: string | null; media_status: string; media_sha256: string | null; thumbnail_path: string | null; title: string };
  inputFile?: string;
  audioFile?: string;
  meta?: MediaMetadata;
  scenes: (SceneBoundary & { framePath?: string; frameFile?: string; visual?: VisualScene; transcriptExcerpt?: string })[];
  transcript: TranscriptResult | null;
  transcriptStatus: "pending" | "completed" | "no_audio" | "unavailable" | "failed";
  framesAnalyzed: number;
  ai: { inputTokens: number; outputTokens: number; costUsd: number; servedModel: string | null; costKnown: boolean };
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------
async function log(c: Ctx, level: "info" | "warn" | "error", step: string | null, message: string, data: Record<string, unknown> = {}) {
  await c.deps.pool.query(
    "insert into public.analysis_job_logs (job_id, workspace_id, level, step, message, data) values ($1, $2, $3, $4, $5, $6)",
    [c.job.id, c.job.workspace_id, level, step, message.slice(0, 2000), JSON.stringify(data)],
  );
}

async function heartbeat(c: Ctx, step: string): Promise<boolean> {
  const { rows } = await c.deps.pool.query("select public.heartbeat_analysis_job($1, $2, $3, $4) as cancel", [c.job.id, c.deps.workerId, step, JSON.stringify(c.steps)]);
  return rows[0].cancel === true;
}

async function tx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const r = await fn(client);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

async function runStep(c: Ctx, id: PipelineStepId, fn: () => Promise<string | void>) {
  const s = c.steps.find((x) => x.step === id)!;
  if (await heartbeat(c, id)) throw new CanceledError();
  s.status = "running";
  s.started_at = new Date().toISOString();
  await heartbeat(c, id);
  try {
    const detail = await fn();
    s.status = detail === "skipped" ? "skipped" : "done";
    if (detail && detail !== "skipped") s.detail = detail;
    s.finished_at = new Date().toISOString();
    await log(c, "info", id, `${PIPELINE_STEPS.find((p) => p.id === id)!.label}: ${s.status}${detail && detail !== "skipped" ? ` — ${detail}` : ""}`);
  } catch (e) {
    s.status = "failed";
    s.finished_at = new Date().toISOString();
    s.detail = e instanceof Error ? e.message.slice(0, 300) : "error";
    throw e;
  } finally {
    await heartbeat(c, id).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// AI invocation with provenance + inline retry on invalid output
// ---------------------------------------------------------------------------
async function callModel<S extends z.ZodType>(c: Ctx, purpose: PromptPurpose, content: ContentPart[], schema: S, sceneCount?: number): Promise<z.infer<S>> {
  const model = c.deps.model!;
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const started = Date.now();
    try {
      const res = await model.generate({ purpose, promptVersion: PROMPT_VERSIONS[purpose], system: SYSTEM_PROMPTS[purpose], content, schema });
      const problems = checkTimestamps(res.data, c.meta!.durationSeconds, sceneCount);
      await c.deps.pool.query(
        `insert into public.ai_invocations (workspace_id, analysis_id, purpose, provider, model, prompt_version, status, input_tokens, output_tokens, latency_ms, cost_usd, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [c.job.workspace_id, c.job.analysis_id, purpose, model.provider, res.servedModel, PROMPT_VERSIONS[purpose], problems.length ? "invalid_output" : "succeeded", res.inputTokens, res.outputTokens, res.latencyMs, res.costUsd, problems.length ? problems.slice(0, 5).join("; ") : null],
      );
      c.ai.inputTokens += res.inputTokens ?? 0;
      c.ai.outputTokens += res.outputTokens ?? 0;
      if (res.costUsd === null) c.ai.costKnown = false;
      else c.ai.costUsd += res.costUsd;
      c.ai.servedModel = res.servedModel;
      if (problems.length) throw new InvalidOutputError(`Output references timestamps/scenes outside the video: ${problems.slice(0, 3).join("; ")}`);
      return res.data;
    } catch (e) {
      const status = e instanceof RefusalError ? "refused" : e instanceof InvalidOutputError ? "invalid_output" : "failed";
      if (!(e instanceof InvalidOutputError && e.message.startsWith("Output references"))) {
        await c.deps.pool.query(
          `insert into public.ai_invocations (workspace_id, analysis_id, purpose, provider, model, prompt_version, status, input_tokens, output_tokens, latency_ms, error)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [c.job.workspace_id, c.job.analysis_id, purpose, model.provider, model.model, PROMPT_VERSIONS[purpose], status, e instanceof InvalidOutputError ? e.usage?.inputTokens ?? null : null, e instanceof InvalidOutputError ? e.usage?.outputTokens ?? null : null, Date.now() - started, (e as Error).message.slice(0, 1000)],
        );
      }
      if (e instanceof RefusalError) throw new PermanentError(e.message);
      if (e instanceof InvalidOutputError) {
        lastError = e;
        await log(c, "warn", purpose, `Invalid ${purpose} output (attempt ${attempt}/2): ${e.message}`);
        continue;
      }
      throw e;
    }
  }
  throw new RetryableError(`AI ${purpose} output was invalid after 2 attempts: ${lastError?.message ?? ""}`);
}

// ---------------------------------------------------------------------------
// Context assembly (only what the model needs: no video bytes, frames only in the visual step)
// ---------------------------------------------------------------------------
function buildContext(c: Ctx): string {
  const m = c.meta!;
  const facts = computeEditingFacts(c.scenes, m.durationSeconds, c.transcript?.segments ?? null);
  const scenes = c.scenes.map((s) => ({
    scene_index: s.idx,
    start_sec: s.startMs / 1000,
    end_sec: s.endMs / 1000,
    duration_sec: (s.endMs - s.startMs) / 1000,
    visual: s.visual ? { description: s.visual.description, framing: s.visual.camera_framing, text_overlays: s.visual.text_overlays, on_screen_elements: s.visual.on_screen_elements } : "not analyzed",
    speech: s.transcriptExcerpt || null,
  }));
  const transcript =
    c.transcriptStatus === "completed" && c.transcript
      ? c.transcript.segments.map((seg) => `[${(seg.startMs / 1000).toFixed(1)}–${(seg.endMs / 1000).toFixed(1)}s] ${seg.text}`).join("\n")
      : `Transcript not available (${c.transcriptStatus}).`;
  return [
    `Reference title (user-provided): ${c.ref.title}`,
    `Media facts (ffprobe): duration ${m.durationSeconds.toFixed(2)}s; ${m.video ? `${m.video.width}x${m.video.height}, ${m.video.fps ?? "?"} fps` : "no video"}; audio: ${m.audio ? "yes" : "no"}.`,
    `Measured editing data (scene detection, threshold ${c.limits.sceneThreshold}): ${JSON.stringify(facts)}`,
    `Scenes (${c.scenes.length}; frames analyzed: ${c.framesAnalyzed}):\n${JSON.stringify(scenes)}`,
    `Timestamped transcript:\n${transcript}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(file).on("data", (d) => hash.update(d)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

async function stepValidate(c: Ctx) {
  const { ref, job } = c;
  if (ref.workspace_id !== job.workspace_id) throw new PermanentError("Reference does not belong to the job's workspace");
  if (ref.media_status !== "uploaded" || !ref.media_path) throw new PermanentError("The reference has no uploaded video");
  if (!ref.media_path.startsWith(`${job.workspace_id}/`)) throw new PermanentError("Media path is outside the workspace");

  const ext = path.extname(ref.media_path).toLowerCase() || ".bin";
  c.inputFile = path.join(c.tmp, `input${ext}`);
  await c.deps.store.download(ref.media_path, c.inputFile);
  const size = (await stat(c.inputFile)).size;
  if (size === 0 || size > c.limits.maxFileBytes) throw new PermanentError(`File size ${size} bytes is outside the allowed range`);

  const fh = await open(c.inputFile, "r");
  const head = Buffer.alloc(16);
  await fh.read(head, 0, 16, 0);
  await fh.close();
  const container = sniffVideoContainer(head);
  if (!container) throw new PermanentError("The file is not a supported video container (MP4, MOV or WebM)");

  const meta = await probe(c.inputFile);
  if (!meta.video) throw new PermanentError("The file has no video stream");
  if (!(meta.durationSeconds > 0)) throw new PermanentError("Could not determine the video duration");
  if (meta.durationSeconds > c.limits.maxDurationSeconds) {
    throw new PermanentError(`Video is ${Math.round(meta.durationSeconds)}s; the maximum is ${c.limits.maxDurationSeconds}s`);
  }
  c.meta = meta;

  const sha = await sha256File(c.inputFile);
  await c.deps.pool.query("update public.video_analyses set media_metadata = $2 where id = $1", [job.analysis_id, JSON.stringify({ ...meta, container, sha256: sha })]);
  await c.deps.pool.query("update public.content_references set duration_seconds = $2 where id = $1", [ref.id, meta.durationSeconds.toFixed(3)]);
  if (ref.media_sha256 !== sha) {
    // Server-verified checksum replaces the client-reported one (duplicates are logged, not fatal).
    await c.deps.pool.query("update public.content_references set media_sha256 = $2 where id = $1", [ref.id, sha]).catch((e) =>
      log(c, "warn", "validate", "Checksum matches another reference in this workspace (duplicate file)", { error: (e as Error).message }),
    );
  }
  return `${container.toUpperCase()}, ${meta.durationSeconds.toFixed(1)}s, ${meta.video.width}x${meta.video.height}`;
}

async function stepMedia(c: Ctx) {
  if (!c.meta!.audio) return "no audio stream";
  c.audioFile = path.join(c.tmp, "audio.mp3");
  await extractAudio(c.inputFile!, c.audioFile);
  const size = (await stat(c.audioFile)).size;
  await c.deps.pool.query("update public.video_analyses set processing = processing || $2 where id = $1", [c.job.analysis_id, JSON.stringify({ audio: { format: "mp3", sampleRate: 16000, channels: 1, bytes: size } })]);
  return `audio extracted (${Math.round(size / 1024)} KB)`;
}

async function stepScenes(c: Ctx) {
  const cuts = await detectSceneCuts(c.inputFile!, path.join(c.tmp, "scenes.txt"), c.limits.sceneThreshold);
  const scenes = buildScenes(cuts, c.meta!.durationSeconds, { minSceneSeconds: c.limits.minSceneSeconds, maxScenes: c.limits.maxScenes });
  for (const s of scenes) {
    const file = path.join(c.tmp, `scene-${String(s.idx).padStart(3, "0")}.jpg`);
    await extractFrame(c.inputFile!, s.frameTimeMs / 1000, file, c.limits.frameWidth);
    const objectPath = `${c.job.workspace_id}/analyses/${c.job.analysis_id}/frames/scene-${String(s.idx).padStart(3, "0")}.jpg`;
    await c.deps.store.upload(objectPath, file, "image/jpeg");
    c.scenes.push({ ...s, frameFile: file, framePath: objectPath });
  }
  await tx(c.deps.pool, async (client) => {
    await client.query("delete from public.detected_scenes where analysis_id = $1", [c.job.analysis_id]);
    for (const s of c.scenes) {
      await client.query(
        `insert into public.detected_scenes (analysis_id, workspace_id, idx, start_ms, end_ms, detection_score, frame_path, frame_time_ms)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [c.job.analysis_id, c.job.workspace_id, s.idx, s.startMs, s.endMs, s.cutScore, s.framePath, s.frameTimeMs],
      );
    }
    await client.query("update public.video_analyses set processing = processing || $2 where id = $1", [
      c.job.analysis_id,
      JSON.stringify({ scene_detection: { threshold: c.limits.sceneThreshold, cuts_detected: cuts.length, scenes: c.scenes.length, min_scene_seconds: c.limits.minSceneSeconds } }),
    ]);
    if (!c.ref.thumbnail_path && c.scenes[0]?.framePath) {
      await client.query("update public.content_references set thumbnail_path = $2 where id = $1 and thumbnail_path is null", [c.ref.id, c.scenes[0].framePath]);
    }
  });
  return `${cuts.length} cut(s) detected → ${c.scenes.length} scene(s)`;
}

async function saveTranscriptStatus(c: Ctx, status: Ctx["transcriptStatus"]) {
  c.transcriptStatus = status;
  await c.deps.pool.query("update public.video_analyses set transcript_status = $2 where id = $1", [c.job.analysis_id, status]);
}

async function stepTranscription(c: Ctx) {
  if (!c.audioFile) {
    await saveTranscriptStatus(c, "no_audio");
    return "skipped";
  }
  if (!c.deps.transcriber) {
    await saveTranscriptStatus(c, "unavailable");
    await log(c, "warn", "transcription", "No transcription provider configured (OPENAI_API_KEY); continuing without a transcript");
    return "skipped";
  }
  let result: TranscriptResult;
  try {
    result = await c.deps.transcriber.transcribe(c.audioFile);
  } catch (e) {
    if (isRetryable(e) && !(e instanceof PermanentError)) throw e;
    await saveTranscriptStatus(c, "failed");
    await log(c, "warn", "transcription", `Transcription failed; continuing without a transcript: ${(e as Error).message}`);
    return "skipped";
  }
  const duration = c.meta!.durationSeconds * 1000;
  const segments: TranscriptSegment[] = result.segments
    .filter((s) => s.text)
    .map((s) => ({ ...s, startMs: Math.min(s.startMs, duration), endMs: Math.min(Math.max(s.endMs, s.startMs), duration) }));
  c.transcript = { ...result, segments };
  await tx(c.deps.pool, async (client) => {
    await client.query("delete from public.transcripts where analysis_id = $1", [c.job.analysis_id]);
    const { rows } = await client.query(
      "insert into public.transcripts (analysis_id, workspace_id, provider, model, language, full_text, duration_seconds) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [c.job.analysis_id, c.job.workspace_id, result.provider, result.model, result.language, result.text, result.durationSeconds],
    );
    for (const [i, s] of segments.entries()) {
      await client.query(
        "insert into public.transcript_segments (transcript_id, workspace_id, idx, start_ms, end_ms, text, speaker, confidence) values ($1, $2, $3, $4, $5, $6, $7, $8)",
        [rows[0].id, c.job.workspace_id, i, s.startMs, s.endMs, s.text, s.speaker, s.confidence],
      );
    }
    for (const sc of c.scenes) {
      sc.transcriptExcerpt = transcriptForScene(sc, segments);
      await client.query("update public.detected_scenes set transcript_excerpt = $3 where analysis_id = $1 and idx = $2", [c.job.analysis_id, sc.idx, sc.transcriptExcerpt || null]);
    }
  });
  await saveTranscriptStatus(c, "completed");
  return `${segments.length} segment(s), language ${result.language ?? "unknown"}`;
}

async function stepVisual(c: Ctx) {
  if (!c.deps.model) throw new PermanentError("AI analysis provider is not configured (ANTHROPIC_API_KEY)");
  const selected = selectScenesForVision(c.scenes.length, c.limits.maxFramesForVision);
  for (let i = 0; i < selected.length; i += c.limits.visionBatchSize) {
    const batch = selected.slice(i, i + c.limits.visionBatchSize).map((idx) => c.scenes[idx]!);
    const content: ContentPart[] = [];
    for (const s of batch) {
      content.push({ type: "text", text: `Scene ${s.idx} (${formatTimestamp(s.startMs)}–${formatTimestamp(s.endMs)}), frame at ${(s.frameTimeMs / 1000).toFixed(2)}s:` });
      content.push({ type: "image", mediaType: "image/jpeg", base64: (await readFile(s.frameFile!)).toString("base64") });
    }
    content.push({ type: "text", text: `Describe these ${batch.length} frames. Valid scene_index values: ${batch.map((s) => s.idx).join(", ")}.` });
    const out = await callModel(c, "visual", content, VisionBatch, c.scenes.length);
    const allowed = new Set(batch.map((s) => s.idx));
    for (const v of out.scenes) {
      if (!allowed.has(v.scene_index)) continue; // never attach descriptions to frames that were not sent
      const scene = c.scenes[v.scene_index]!;
      scene.visual = v;
      await c.deps.pool.query("update public.detected_scenes set visual = $3, visual_analyzed = true where analysis_id = $1 and idx = $2", [c.job.analysis_id, v.scene_index, JSON.stringify(v)]);
    }
  }
  c.framesAnalyzed = c.scenes.filter((s) => s.visual).length;
  const status = c.framesAnalyzed === c.scenes.length ? "completed" : c.framesAnalyzed > 0 ? "partial" : "failed";
  await c.deps.pool.query("update public.video_analyses set visual_status = $2 where id = $1", [c.job.analysis_id, status]);
  return `${c.framesAnalyzed} of ${c.scenes.length} frame(s) analyzed`;
}

interface AiResults {
  hook: z.infer<typeof HookAnalysis>;
  narrative: z.infer<typeof NarrativeAnalysis>;
  editing: z.infer<typeof EditingAnalysis>;
  summary: z.infer<typeof ContentSummary>;
  creative: z.infer<typeof CreativeOpportunities>;
}

async function stepAnalysis(c: Ctx): Promise<AiResults> {
  const context: ContentPart[] = [{ type: "text", text: buildContext(c) }];
  const n = c.scenes.length;
  const [hook, narrative, editing, summary] = await Promise.all([
    callModel(c, "hook", context, HookAnalysis, n),
    callModel(c, "narrative", context, NarrativeAnalysis, n),
    callModel(c, "editing", context, EditingAnalysis, n),
    callModel(c, "summary", context, ContentSummary, n),
  ]);
  const creative = await callModel(
    c,
    "creative",
    [...context, { type: "text", text: `Prior analysis:\n${JSON.stringify({ summary, hook, storytelling: narrative.storytelling })}` }],
    CreativeOpportunities,
    n,
  );
  for (const note of editing.scene_notes) {
    if (note.scene_index < 0 || note.scene_index >= n) continue;
    await c.deps.pool.query("update public.detected_scenes set purpose = $3, editing_notes = $4 where analysis_id = $1 and idx = $2", [c.job.analysis_id, note.scene_index, note.purpose, note.editing_notes]);
  }
  return { hook, narrative, editing, summary, creative };
}

async function stepReport(c: Ctx, ai: AiResults, startedAt: number) {
  const { scene_notes: _omit, ...editingObs } = ai.editing;
  void _omit;
  const sections = ReportSections.parse({
    summary: ai.summary,
    hook: ai.hook,
    storytelling: ai.narrative.storytelling,
    retention: ai.narrative.retention,
    cta: ai.narrative.cta,
    editing: { measured: computeEditingFacts(c.scenes, c.meta!.durationSeconds, c.transcript?.segments ?? null), observations: editingObs },
    creative: ai.creative,
    inputs: {
      transcript: c.transcriptStatus === "pending" ? "unavailable" : c.transcriptStatus,
      scenesTotal: c.scenes.length,
      framesAnalyzed: c.framesAnalyzed,
      durationSeconds: c.meta!.durationSeconds,
    },
  });
  await c.deps.pool.query(
    `insert into public.analysis_reports (analysis_id, workspace_id, schema_version, sections, model_provider, model_id, prompt_versions, input_tokens, output_tokens, cost_usd, processing_ms)
     values ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (analysis_id) do update set sections = excluded.sections, model_provider = excluded.model_provider, model_id = excluded.model_id,
       prompt_versions = excluded.prompt_versions, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
       cost_usd = excluded.cost_usd, processing_ms = excluded.processing_ms`,
    [
      c.job.analysis_id,
      c.job.workspace_id,
      JSON.stringify(sections),
      c.deps.model!.provider,
      c.ai.servedModel ?? c.deps.model!.model,
      JSON.stringify(PROMPT_VERSIONS),
      c.ai.inputTokens,
      c.ai.outputTokens,
      c.ai.costKnown ? c.ai.costUsd.toFixed(6) : null,
      Date.now() - startedAt,
    ],
  );
  return `report saved (${c.ai.inputTokens + c.ai.outputTokens} tokens)`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
export async function processJob(job: ClaimedJob, deps: PipelineDeps): Promise<JobOutcome> {
  const startedAt = Date.now();
  const tmp = await mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "cos-analysis-"));
  const c: Ctx = {
    job,
    deps,
    limits: { ...ANALYSIS_LIMITS, ...deps.limits },
    steps: PIPELINE_STEPS.map((s) => ({ step: s.id, status: "pending" })),
    tmp,
    ref: undefined as unknown as Ctx["ref"],
    scenes: [],
    transcript: null,
    transcriptStatus: "pending",
    framesAnalyzed: 0,
    ai: { inputTokens: 0, outputTokens: 0, costUsd: 0, servedModel: null, costKnown: true },
  };
  try {
    await log(c, "info", null, `Attempt ${job.attempts} of ${job.max_attempts} started by ${deps.workerId}`);
    if (job.attempts > job.max_attempts) throw new PermanentError("Maximum attempts exceeded");
    const { rows } = await deps.pool.query(
      `select r.id, r.workspace_id, r.media_path, r.media_status, r.media_sha256, r.thumbnail_path, r.title
       from public.video_analyses a join public.content_references r on r.id = a.reference_id
       where a.id = $1 and a.workspace_id = $2`,
      [job.analysis_id, job.workspace_id],
    );
    if (!rows[0]) throw new PermanentError("Analysis or reference no longer exists");
    c.ref = rows[0];

    await runStep(c, "validate", () => stepValidate(c));
    await runStep(c, "media", () => stepMedia(c));
    await runStep(c, "scenes", () => stepScenes(c));
    await runStep(c, "transcription", () => stepTranscription(c));
    await runStep(c, "visual", () => stepVisual(c));
    let ai: AiResults | undefined;
    await runStep(c, "analysis", async () => {
      ai = await stepAnalysis(c);
      return "hook, narrative, editing, summary and creative analyses validated";
    });
    await runStep(c, "report", () => stepReport(c, ai!, startedAt));

    await deps.pool.query("select public.finish_analysis_job($1, $2)", [job.id, deps.workerId]);
    return "succeeded";
  } catch (err) {
    if (err instanceof CanceledError) {
      await log(c, "warn", null, "Canceled by user; credits refunded");
      await deps.pool.query("select public.cancel_running_analysis_job($1, $2)", [job.id, deps.workerId]);
      return "canceled";
    }
    const retryable = isRetryable(err);
    const message = err instanceof Error ? err.message : String(err);
    await log(c, "error", c.steps.find((s) => s.status === "failed")?.step ?? null, message, { retryable }).catch(() => undefined);
    await heartbeat(c, "failed").catch(() => undefined);
    const backoff = Math.min(30 * 2 ** Math.max(0, job.attempts - 1), 15 * 60);
    const { rows } = await deps.pool.query("select public.fail_analysis_job($1, $2, $3, $4, $5) as r", [job.id, deps.workerId, message, retryable, backoff]);
    return rows[0].r as JobOutcome;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function claimJob(pool: Pool, workerId: string): Promise<ClaimedJob | null> {
  const { rows } = await pool.query("select id, workspace_id, analysis_id, attempts, max_attempts from public.claim_analysis_job($1)", [workerId]);
  return rows[0] ?? null;
}
