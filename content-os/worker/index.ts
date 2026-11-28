/**
 * Content OS analysis worker. Runs separately from the Next.js app:
 *
 *   npm run worker
 *
 * Polls two Postgres-backed queues (FOR UPDATE SKIP LOCKED): video analyses
 * (claim_analysis_job) and Video Studio jobs — asset processing, voiceover
 * transcription and rendering (claim_video_job). One job at a time per
 * process; scale horizontally by running more processes. WORKER_QUEUES
 * ("analysis,video" by default) lets you dedicate processes, e.g. to renders.
 * Requires ffmpeg/ffprobe (with libass) and a font such as DejaVu Sans.
 */
import { hostname } from "node:os";
import pg from "pg";
import { ClaudeAnalysisModel, DEFAULT_ANALYSIS_MODEL } from "@/server/analysis/ai/claude";
import { claimJob, processJob, type PipelineDeps } from "@/server/analysis/pipeline";
import { LocalMediaStore, SupabaseMediaStore, type MediaStore } from "@/server/analysis/storage";
import { OpenAIWhisperProvider } from "@/server/analysis/transcription/openai-whisper";
import { claimVideoJob, processVideoJob, type VideoWorkerDeps } from "@/server/video/worker";

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[worker] Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

function buildStore(): MediaStore {
  const local = process.env.MEDIA_STORE_LOCAL_DIR;
  if (local) return new LocalMediaStore(local);
  return new SupabaseMediaStore(process.env.SUPABASE_URL ?? required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"));
}

async function main() {
  const workerId = process.env.WORKER_ID ?? `${hostname()}-${process.pid}`;
  const pollMs = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 3000);
  const pool = new pg.Pool({ connectionString: required("DATABASE_URL"), max: 4 });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey = process.env.OPENAI_API_KEY;
  const deps: PipelineDeps = {
    pool,
    store: buildStore(),
    workerId,
    transcriber: openaiKey ? new OpenAIWhisperProvider(openaiKey) : null,
    model: anthropicKey
      ? new ClaudeAnalysisModel(process.env.ANALYSIS_MODEL ?? DEFAULT_ANALYSIS_MODEL, { apiKey: anthropicKey, fallbacks: process.env.ANTHROPIC_DISABLE_FALLBACKS !== "1" })
      : null,
  };
  const videoDeps: VideoWorkerDeps = { pool, store: deps.store, transcriber: deps.transcriber, workerId, fontsDir: process.env.WORKER_FONTS_DIR ?? null };
  const queues = new Set((process.env.WORKER_QUEUES ?? "analysis,video").split(",").map((q) => q.trim()));
  console.log(`[worker] queues: ${[...queues].join(", ")}`);
  console.log(`[worker] ${workerId} started · transcription: ${deps.transcriber ? "openai whisper-1" : "NOT CONFIGURED"} · AI: ${deps.model ? deps.model.model : "NOT CONFIGURED"}`);

  let stopping = false;
  const stop = () => {
    if (!stopping) console.log("[worker] shutting down after current job…");
    stopping = true;
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  while (!stopping) {
    let worked = false;
    if (queues.has("analysis")) {
      let job = null;
      try {
        job = await claimJob(pool, workerId);
      } catch (e) {
        console.error("[worker] analysis claim failed:", (e as Error).message);
      }
      if (job) {
        worked = true;
        const started = Date.now();
        console.log(`[worker] analysis job ${job.id} (analysis ${job.analysis_id}) attempt ${job.attempts}`);
        const outcome = await processJob(job, deps).catch((e) => {
          console.error(`[worker] job ${job!.id} crashed:`, (e as Error).message);
          return "crashed";
        });
        console.log(`[worker] analysis job ${job.id} → ${outcome} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
    }
    if (!stopping && queues.has("video")) {
      let vjob = null;
      try {
        vjob = await claimVideoJob(pool, workerId);
      } catch (e) {
        console.error("[worker] video claim failed:", (e as Error).message);
      }
      if (vjob) {
        worked = true;
        const started = Date.now();
        console.log(`[worker] video ${vjob.kind} job ${vjob.id} attempt ${vjob.attempts}`);
        const outcome = await processVideoJob(vjob, videoDeps).catch((e) => {
          console.error(`[worker] video job ${vjob!.id} crashed:`, (e as Error).message);
          return "crashed";
        });
        console.log(`[worker] video job ${vjob.id} → ${outcome} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
      }
    }
    if (!worked) await new Promise((r) => setTimeout(r, pollMs));
  }
  await pool.end();
}

main().catch((e) => {
  console.error("[worker] fatal:", e);
  process.exit(1);
});
