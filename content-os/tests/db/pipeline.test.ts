import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReportSections } from "@/server/analysis/ai/schemas";
import { RetryableError } from "@/server/analysis/errors";
import { claimJob, processJob, type PipelineDeps } from "@/server/analysis/pipeline";
import { LocalMediaStore } from "@/server/analysis/storage";
import { MOCK_TRANSCRIPT, MockAnalysisModel, MockTranscriber } from "../fixtures/fake-providers";
import { makeFakeVideo, makeThreeSceneVideo } from "../fixtures/media";
import { asUser, createReference, createUser, createWorkspace, creditBalance, pool, sql, uploadVideo, upgradePlan, type TestUser } from "./helpers";

/**
 * Integration tests for the analysis pipeline: REAL ffmpeg/ffprobe, REAL
 * Postgres queue + RLS schema, local media store, MOCK transcription/AI.
 */
let owner: TestUser;
let ws: { id: string };
let mediaRoot: string;
let store: LocalMediaStore;
let fixtures: { video: string; silent: string; fake: string };

beforeAll(async () => {
  owner = await createUser();
  ws = await createWorkspace(owner, "Pipeline WS");
  await upgradePlan(ws.id);
  await sql("select public.apply_credit_transaction($1, 'grant', 1000, 'test top-up')", [ws.id]);
  const dir = mkdtempSync(path.join(os.tmpdir(), "cos-fixtures-"));
  fixtures = { video: makeThreeSceneVideo(dir), silent: makeThreeSceneVideo(dir, { audio: false }), fake: makeFakeVideo(dir) };
  mediaRoot = mkdtempSync(path.join(os.tmpdir(), "cos-media-"));
  store = new LocalMediaStore(mediaRoot);
}, 60_000);

afterAll(() => pool.end());

async function drain() {
  await sql("update public.analysis_jobs set status = 'canceled' where status in ('queued','running')");
  await sql("update public.video_analyses set status = 'canceled' where status in ('queued','processing')");
}

/** Creates a reference with the given file uploaded, requests analysis and claims the job. */
async function queued(file: string) {
  await drain();
  const ref = await createReference(owner, ws.id, { title: "Fixture" });
  const objectPath = await uploadVideo(owner, ref.id);
  mkdirSync(path.dirname(path.join(mediaRoot, objectPath)), { recursive: true });
  await copyFile(file, path.join(mediaRoot, objectPath));
  const { rows } = await asUser(owner, (q) => q("select public.request_analysis($1) as id", [ref.id]));
  const job = await claimJob(pool, "test-worker");
  expect(job?.analysis_id).toBe(rows[0].id);
  return { refId: ref.id, analysisId: rows[0].id as string, job: job! };
}

function deps(over: Partial<PipelineDeps> = {}): PipelineDeps {
  return { pool, store, transcriber: new MockTranscriber(), model: new MockAnalysisModel(), workerId: "test-worker", ...over };
}

const analysisRow = async (id: string) =>
  (await sql("select a.status, a.transcript_status, a.visual_status, a.error, a.credits_refunded, a.media_metadata, j.status as job_status, j.attempts, j.steps from public.video_analyses a join public.analysis_jobs j on j.analysis_id = a.id where a.id = $1", [id])).rows[0];

describe("full pipeline on a real video", () => {
  let analysisId: string;
  let refId: string;
  const model = new MockAnalysisModel();

  beforeAll(async () => {
    const q = await queued(fixtures.video);
    analysisId = q.analysisId;
    refId = q.refId;
    expect(await processJob(q.job, deps({ model }))).toBe("succeeded");
  }, 120_000);

  it("completes the analysis and the job, with every step recorded", async () => {
    const a = await analysisRow(analysisId);
    expect(a).toMatchObject({ status: "completed", job_status: "succeeded", transcript_status: "completed", visual_status: "completed", credits_refunded: false });
    expect(a.steps.map((s: { step: string; status: string }) => `${s.step}:${s.status}`)).toEqual([
      "validate:done", "media:done", "scenes:done", "transcription:done", "visual:done", "analysis:done", "report:done",
    ]);
  });

  it("stores real ffprobe metadata", async () => {
    const { media_metadata: m } = await analysisRow(analysisId);
    expect(m.durationSeconds).toBeGreaterThan(5.8);
    expect(m.durationSeconds).toBeLessThan(6.2);
    expect(m.video).toMatchObject({ codec: "h264", width: 320, height: 240 });
    expect(m.audio).toMatchObject({ codec: "aac" });
    expect(m.container).toBe("mp4");
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives scene boundaries from actual scene detection (cuts at ~2s and ~4s)", async () => {
    const { rows } = await sql("select idx, start_ms, end_ms, duration_ms, detection_score, frame_path, visual_analyzed, purpose, transcript_excerpt from public.detected_scenes where analysis_id = $1 order by idx", [analysisId]);
    expect(rows).toHaveLength(3);
    expect(rows[0].start_ms).toBe(0);
    expect(Math.abs(rows[1].start_ms - 2000)).toBeLessThanOrEqual(80);
    expect(Math.abs(rows[2].start_ms - 4000)).toBeLessThanOrEqual(80);
    expect(rows[0].detection_score).toBeNull();
    expect(Number(rows[1].detection_score)).toBeGreaterThan(0.3);
    for (const r of rows) {
      expect(existsSync(path.join(mediaRoot, r.frame_path))).toBe(true); // representative frame really exists
      expect(r.visual_analyzed).toBe(true);
    }
    expect(rows.map((r) => r.purpose)).toEqual(["Hook", "Body", "CTA"]);
    expect(rows.map((r) => r.transcript_excerpt)).toEqual(["Stop scrolling.", "Here are three colours.", "Follow for more."]);
  });

  it("sends only representative frames (one JPEG per scene) to the vision model", () => {
    const visual = model.calls.filter((c) => c.purpose === "visual");
    expect(visual.reduce((n, c) => n + c.images, 0)).toBe(3);
    for (const size of visual.flatMap((c) => c.imageBytes)) expect(size).toBeGreaterThan(500);
    const nonVisual = model.calls.filter((c) => c.purpose !== "visual");
    expect(nonVisual.every((c) => c.images === 0)).toBe(true);
    expect(new Set(model.calls.map((c) => c.purpose))).toEqual(new Set(["visual", "hook", "narrative", "editing", "summary", "creative"]));
  });

  it("persists the transcript with original timestamps", async () => {
    const { rows } = await sql("select s.idx, s.start_ms, s.end_ms, s.text, s.confidence from public.transcript_segments s join public.transcripts t on t.id = s.transcript_id where t.analysis_id = $1 order by s.idx", [analysisId]);
    expect(rows.map((r) => [r.start_ms, r.end_ms, r.text])).toEqual(MOCK_TRANSCRIPT.segments.map((s) => [s.startMs, s.endMs, s.text]));
  });

  it("persists a schema-valid report with measured editing facts and provenance", async () => {
    const { rows } = await sql("select * from public.analysis_reports where analysis_id = $1", [analysisId]);
    const report = rows[0];
    const sections = ReportSections.parse(report.sections);
    expect(sections.editing.measured.sceneCount).toBe(3);
    expect(sections.editing.measured.cutsPerMinute).toBeCloseTo(20, 0);
    expect(sections.inputs).toMatchObject({ transcript: "completed", scenesTotal: 3, framesAnalyzed: 3 });
    expect(sections.hook.opening_statement).toBe("Stop scrolling.");
    expect(report).toMatchObject({ model_provider: "mock", model_id: "mock-claude", input_tokens: 600, output_tokens: 300 });
    expect(report.prompt_versions).toMatchObject({ hook: "hook@1", visual: "visual@1" });
    expect(Number(report.cost_usd)).toBeCloseTo(0.006, 6);
  });

  it("records every AI invocation", async () => {
    const { rows } = await sql("select purpose, status, prompt_version from public.ai_invocations where analysis_id = $1", [analysisId]);
    expect(rows).toHaveLength(6);
    expect(rows.every((r) => r.status === "succeeded" && r.prompt_version.includes("@"))).toBe(true);
  });

  it("marks the reference analyzed and sets its thumbnail from the first scene", async () => {
    const { rows } = await sql("select analysis_status, thumbnail_path, duration_seconds from public.content_references where id = $1", [refId]);
    expect(rows[0].analysis_status).toBe("analyzed");
    expect(rows[0].thumbnail_path).toMatch(/frames\/scene-000\.jpg$/);
    expect(Number(rows[0].duration_seconds)).toBeCloseTo(6, 0);
  });

  it("members can read results; job logs explain each step", async () => {
    const { rows } = await asUser(owner, (q) => q("select count(*)::int as n from public.analysis_job_logs l join public.analysis_jobs j on j.id = l.job_id where j.analysis_id = $1", [analysisId]));
    expect(rows[0].n).toBeGreaterThanOrEqual(8);
  });
});

describe("degraded inputs", () => {
  it("continues without a transcript when no transcription provider is configured", async () => {
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ transcriber: null }))).toBe("succeeded");
    const a = await analysisRow(q.analysisId);
    expect(a.transcript_status).toBe("unavailable");
    const { rows } = await sql("select sections from public.analysis_reports where analysis_id = $1", [q.analysisId]);
    expect(rows[0].sections.inputs.transcript).toBe("unavailable");
  }, 60_000);

  it("skips transcription for videos without an audio stream", async () => {
    const t = new MockTranscriber();
    const q = await queued(fixtures.silent);
    expect(await processJob(q.job, deps({ transcriber: t }))).toBe("succeeded");
    expect((await analysisRow(q.analysisId)).transcript_status).toBe("no_audio");
    expect(t.calls).toBe(0);
  }, 60_000);
});

describe("failure handling", () => {
  it("rejects a non-video file permanently, without executing it, and refunds credits", async () => {
    const before = await creditBalance(ws.id);
    const q = await queued(fixtures.fake);
    expect(await processJob(q.job, deps())).toBe("failed");
    const a = await analysisRow(q.analysisId);
    expect(a).toMatchObject({ status: "failed", job_status: "failed", credits_refunded: true });
    expect(a.error).toMatch(/not a supported video container/);
    expect(await creditBalance(ws.id)).toBe(before);
    expect(existsSync("/tmp/pwned")).toBe(false);
  });

  it("enforces the duration limit", async () => {
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ limits: { maxDurationSeconds: 3 } }))).toBe("failed");
    expect((await analysisRow(q.analysisId)).error).toMatch(/maximum is 3s/);
  });

  it("fails clearly (and refunds) when no AI provider is configured", async () => {
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ model: null }))).toBe("failed");
    const a = await analysisRow(q.analysisId);
    expect(a.error).toMatch(/AI analysis provider is not configured/);
    expect(a.credits_refunded).toBe(true);
  }, 60_000);

  it("retries transient failures and the retry is idempotent (no duplicate rows)", async () => {
    const flaky = new MockTranscriber(async (call) => {
      if (call === 1) throw new RetryableError("provider 503");
      return MOCK_TRANSCRIPT;
    });
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ transcriber: flaky }))).toBe("retry_scheduled");
    let a = await analysisRow(q.analysisId);
    expect(a).toMatchObject({ job_status: "queued", attempts: 1 });
    const { rows: logs } = await sql("select level, message from public.analysis_job_logs l join public.analysis_jobs j on j.id = l.job_id where j.analysis_id = $1 and level = 'error'", [q.analysisId]);
    expect(logs[0].message).toMatch(/provider 503/);

    await sql("update public.analysis_jobs set run_after = now() where id = $1", [q.job.id]);
    const again = await claimJob(pool, "test-worker");
    expect(again?.id).toBe(q.job.id);
    expect(await processJob(again!, deps({ transcriber: flaky }))).toBe("succeeded");
    a = await analysisRow(q.analysisId);
    expect(a).toMatchObject({ status: "completed", attempts: 2 });
    const { rows } = await sql("select count(*)::int as n from public.detected_scenes where analysis_id = $1", [q.analysisId]);
    expect(rows[0].n).toBe(3);
    const t = await sql("select count(*)::int as n from public.transcripts where analysis_id = $1", [q.analysisId]);
    expect(t.rows[0].n).toBe(1);
  }, 120_000);

  it("re-asks the model once when output references timestamps outside the video", async () => {
    const model = new MockAnalysisModel((purpose, n) =>
      purpose === "hook" && n === 1
        ? { opening_statement: null, hook_type: "other", attention_mechanism: "x", curiosity_element: null, estimated_hook_duration_sec: 99, evidence: [{ timestamp_sec: 120, observation: "invented" }], interpretation: "x" }
        : undefined,
    );
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ model }))).toBe("succeeded");
    const { rows } = await sql("select status from public.ai_invocations where analysis_id = $1 and purpose = 'hook' order by created_at", [q.analysisId]);
    expect(rows.map((r) => r.status)).toEqual(["invalid_output", "succeeded"]);
  }, 60_000);

  it("schedules a retry when the model keeps returning invalid output", async () => {
    const model = new MockAnalysisModel((purpose) => (purpose === "summary" ? { main_topic: 42 } : undefined));
    const q = await queued(fixtures.video);
    expect(await processJob(q.job, deps({ model }))).toBe("retry_scheduled");
    const { rows } = await sql("select count(*)::int as n from public.analysis_reports where analysis_id = $1", [q.analysisId]);
    expect(rows[0].n).toBe(0); // nothing invalid is ever stored
  }, 60_000);

  it("honours cancellation between steps and refunds credits", async () => {
    let analysisId = "";
    const cancelling = new MockTranscriber(async () => {
      await sql("update public.analysis_jobs set cancel_requested = true where analysis_id = $1", [analysisId]);
      return MOCK_TRANSCRIPT;
    });
    const q = await queued(fixtures.video);
    analysisId = q.analysisId;
    const model = new MockAnalysisModel();
    expect(await processJob(q.job, deps({ transcriber: cancelling, model }))).toBe("canceled");
    expect(await analysisRow(q.analysisId)).toMatchObject({ status: "canceled", job_status: "canceled", credits_refunded: true });
    expect(model.calls).toHaveLength(0); // stopped before any AI spend
  }, 60_000);
});
