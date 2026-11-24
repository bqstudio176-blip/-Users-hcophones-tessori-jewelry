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
