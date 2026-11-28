import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ANALYSIS_LIMITS } from "../config";
import { PermanentError } from "../errors";

const exec = promisify(execFile);

/**
 * All media tools run via execFile with an argument ARRAY (no shell, so file
 * names can never inject commands), a timeout and a bounded output buffer.
 * Uploaded files are only ever read by ffmpeg/ffprobe — never executed.
 */
async function run(bin: string, args: string[], timeoutMs: number = ANALYSIS_LIMITS.commandTimeoutMs) {
  try {
    return await exec(bin, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; code?: unknown; message: string };
    if (e.killed) throw new Error(`${bin} timed out after ${timeoutMs} ms`);
    if (e.code === "ENOENT") throw new PermanentError(`${bin} is not installed on the worker`);
    const tail = (e.stderr ?? "").trim().split("\n").slice(-3).join(" | ");
    throw new Error(`${bin} failed: ${tail || e.message}`.slice(0, 500));
  }
}

export interface MediaMetadata {
  durationSeconds: number;
  formatName: string;
  sizeBytes: number | null;
  bitRate: number | null;
  video: { codec: string; width: number; height: number; fps: number | null; rotation: number | null } | null;
  audio: { codec: string; sampleRate: number | null; channels: number | null } | null;
}

interface ProbeJson {
  format?: { duration?: string; format_name?: string; size?: string; bit_rate?: string };
  streams?: Array<{
    codec_type?: string;
    codec_name?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    r_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
    side_data_list?: Array<{ rotation?: number }>;
    tags?: { rotate?: string };
  }>;
}

function fps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [n, d] = rate.split("/").map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 100) / 100;
}

export function parseProbe(json: ProbeJson): MediaMetadata {
  const v = json.streams?.find((s) => s.codec_type === "video");
  const a = json.streams?.find((s) => s.codec_type === "audio");
  const duration = Number(json.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    formatName: json.format?.format_name ?? "unknown",
    sizeBytes: json.format?.size ? Number(json.format.size) : null,
    bitRate: json.format?.bit_rate ? Number(json.format.bit_rate) : null,
    video: v
      ? {
          codec: v.codec_name ?? "unknown",
          width: v.width ?? 0,
          height: v.height ?? 0,
          fps: fps(v.avg_frame_rate) ?? fps(v.r_frame_rate),
          rotation: v.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? (v.tags?.rotate ? Number(v.tags.rotate) : null),
        }
      : null,
    audio: a ? { codec: a.codec_name ?? "unknown", sampleRate: a.sample_rate ? Number(a.sample_rate) : null, channels: a.channels ?? null } : null,
  };
}

export async function probe(file: string): Promise<MediaMetadata> {
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", file], 60_000).catch((e) => {
    throw new PermanentError(`The file could not be read as media (${e instanceof Error ? e.message : "ffprobe error"})`);
  });
  let json: ProbeJson;
  try {
    json = JSON.parse(stdout);
  } catch {
    throw new PermanentError("ffprobe returned unreadable output");
  }
  return parseProbe(json);
}

/** Mono 16 kHz 64 kbps MP3: small enough for transcription APIs (≈ 0.5 MB/min). */
export async function extractAudio(input: string, output: string): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "-f", "mp3", output]);
}

export interface SceneCut {
  timeSeconds: number;
  score: number;
}

/** Parses the output of ffmpeg's `metadata=print` filter after `select='gt(scene,T)'`. */
export function parseSceneMetadata(text: string): SceneCut[] {
  const cuts: SceneCut[] = [];
  let pendingTime: number | null = null;
  for (const line of text.split("\n")) {
    const t = /pts_time:([0-9.]+)/.exec(line);
    if (t) pendingTime = Number(t[1]);
    const s = /lavfi\.scene_score=([0-9.]+)/.exec(line);
    if (s && pendingTime !== null) {
      cuts.push({ timeSeconds: pendingTime, score: Number(s[1]) });
      pendingTime = null;
    }
  }
  return cuts;
}

/** Runs ffmpeg scene-change detection; returns the timestamps where scores exceed the threshold. */
export async function detectSceneCuts(input: string, metadataFile: string, threshold: number = ANALYSIS_LIMITS.sceneThreshold): Promise<SceneCut[]> {
  const { readFile } = await import("node:fs/promises");
  // The metadata file path is created by us inside the job temp dir; escape for the filter graph anyway.
  const escaped = metadataFile.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:");
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", input, "-an", "-vf", `select='gt(scene,${threshold})',metadata=print:file='${escaped}'`, "-f", "null", "-"]);
  const text = await readFile(metadataFile, "utf8").catch(() => "");
  return parseSceneMetadata(text);
}

export async function extractFrame(input: string, timeSeconds: number, output: string, width: number = ANALYSIS_LIMITS.frameWidth): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-ss", timeSeconds.toFixed(3), "-i", input, "-frames:v", "1", "-vf", `scale=${width}:-2`, "-q:v", "4", output], 60_000);
}

// ---------------------------------------------------------------------------
// Video Studio helpers (same execFile wrapper: argument arrays, timeouts)
// ---------------------------------------------------------------------------

/** Runs ffmpeg with a prepared argument array. `signal` aborts (kills) the process. */
export async function runFfmpeg(args: string[], opts: { timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string; stderr: string }> {
  try {
    const r = await exec("ffmpeg", args, { timeout: opts.timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true, signal: opts.signal });
    return { stdout: String(r.stdout), stderr: String(r.stderr) };
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; code?: unknown; name?: string; message: string };
    if (e.name === "AbortError" || opts.signal?.aborted) throw new Error("ffmpeg aborted");
    if (e.killed) throw new Error(`ffmpeg timed out after ${opts.timeoutMs} ms`);
    if (e.code === "ENOENT") throw new PermanentError("ffmpeg is not installed on the worker");
    const tail = (e.stderr ?? "").trim().split("\n").slice(-4).join(" | ");
    throw new Error(`ffmpeg failed: ${tail || e.message}`.slice(0, 800));
  }
}

/** Parses the summary printed by the ebur128 filter (last occurrence wins). */
export function parseEbur128(stderr: string): { integratedLufs: number | null; truePeakDb: number | null } {
  const i = [...stderr.matchAll(/I:\s+(-?[\d.]+|-inf) LUFS/g)].pop()?.[1];
  const p = [...stderr.matchAll(/Peak:\s+(-?[\d.]+|-inf) dBFS/g)].pop()?.[1];
  const num = (s: string | undefined) => (s === undefined ? null : s === "-inf" ? -120 : Number(s));
  return { integratedLufs: num(i), truePeakDb: num(p) };
}

export async function measureLoudness(file: string, timeoutMs = 5 * 60_000): Promise<{ integratedLufs: number | null; truePeakDb: number | null }> {
  const { stderr } = await run("ffmpeg", ["-nostdin", "-hide_banner", "-nostats", "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"], timeoutMs);
  return parseEbur128(String(stderr));
}

/** Low-resolution H.264/AAC proxy for smooth browser preview. */
export async function makeVideoProxy(input: string, output: string, timeoutMs = 15 * 60_000): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", input, "-vf", "scale='min(540,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", "-ac", "2", "-movflags", "+faststart", output], timeoutMs);
}

/** AAC proxy so recordings in any browser format play everywhere. */
export async function makeAudioProxy(input: string, output: string, timeoutMs = 10 * 60_000): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", input, "-vn", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-ar", "48000", "-f", "mp4", output], timeoutMs);
}

/** JPEG thumbnail from a video frame or an image. */
export async function makeThumbnail(input: string, output: string, atSeconds: number | null, width = 480): Promise<void> {
  const seek = atSeconds !== null ? ["-ss", atSeconds.toFixed(3)] : [];
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", ...seek, "-i", input, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", "4", output], 60_000);
}

/** Normalises an image (any supported format/orientation) to a JPEG the renderer can loop. */
export async function normaliseImage(input: string, output: string, maxSide = 2160): Promise<void> {
  await run("ffmpeg", ["-nostdin", "-y", "-v", "error", "-i", input, "-frames:v", "1", "-vf", `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))'`, "-q:v", "2", output], 120_000);
}
