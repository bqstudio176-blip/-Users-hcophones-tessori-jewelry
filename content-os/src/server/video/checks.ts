import { overflowingText } from "./captions";
import { timelineDuration, VIDEO_FORMATS, VIDEO_LIMITS, type Timeline } from "./timeline";

/**
 * Deterministic pre-publish checks, computed in code from the timeline and
 * from measurements of the rendered file (ffprobe + ebur128). No AI.
 */
export type CheckStatus = "pass" | "warn" | "fail";
export interface CheckItem {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}
export interface CheckReport {
  overall: CheckStatus;
  items: CheckItem[];
}

export interface RenderStats {
  durationSeconds: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
  fps: number | null;
  bitRate: number | null;
  integratedLufs: number | null;
  truePeakDb: number | null;
}

/** Same tolerance rule as Script Lab: ±15 %, at least ±3 s. */
export const durationTolerance = (target: number) => Math.max(3, target * 0.15);

/** Gaps longer than 2 s between spoken words while a voiceover is expected. */
export function voiceGaps(words: { start: number; end: number }[], offset = 0): { from: number; to: number }[] {
  const gaps: { from: number; to: number }[] = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i]!.start - words[i - 1]!.end;
    if (gap > 2) gaps.push({ from: Math.round((words[i - 1]!.end + offset) * 10) / 10, to: Math.round((words[i]!.start + offset) * 10) / 10 });
  }
  return gaps;
}

export function evaluateChecks(input: {
  timeline: Timeline;
  kind: "draft" | "final";
  stats: RenderStats;
  targetSeconds: number | null;
  scriptChanged: boolean;
  gaps: { from: number; to: number }[];
}): CheckReport {
  const { timeline: t, stats } = input;
  const items: CheckItem[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) => items.push({ id, label, status, detail });
  const fmt = VIDEO_FORMATS[t.format];

  add("render_kind", "Final render", input.kind === "final" ? "pass" : "fail", input.kind === "final" ? "Full-resolution render." : "Draft renders are low resolution and watermarked; render a final version before publishing.");

  const planned = timelineDuration(t);
  const durOk = Math.abs(stats.durationSeconds - planned) <= 0.5;
  add("duration_match", "Rendered duration", durOk ? "pass" : "warn", `${stats.durationSeconds.toFixed(1)}s rendered vs ${planned.toFixed(1)}s planned.`);
  add("duration_limit", "Maximum length", stats.durationSeconds <= VIDEO_LIMITS.maxOutputSeconds + 0.5 ? "pass" : "fail", `Limit ${VIDEO_LIMITS.maxOutputSeconds}s.`);
  if (input.targetSeconds) {
    const tol = durationTolerance(input.targetSeconds);
    const within = Math.abs(stats.durationSeconds - input.targetSeconds) <= tol;
    add("duration_target", "Script target", within ? "pass" : "warn", `${stats.durationSeconds.toFixed(1)}s vs target ${input.targetSeconds}s (±${tol.toFixed(1)}s).`);
  }

  if (input.kind === "final") {
    const resOk = stats.width === fmt.width && stats.height === fmt.height;
    add("resolution", "Resolution", resOk ? "pass" : "fail", `${stats.width}×${stats.height} (expected ${fmt.width}×${fmt.height}).`);
  } else {
    add("resolution", "Resolution", "warn", `${stats.width}×${stats.height} draft (final is ${fmt.width}×${fmt.height}).`);
  }
  const codecOk = stats.videoCodec === "h264" && stats.audioCodec === "aac";
  add("codecs", "Codecs", codecOk ? "pass" : "fail", `Video ${stats.videoCodec ?? "missing"}, audio ${stats.audioCodec ?? "missing"} (expected H.264 + AAC).`);
  const fpsOk = stats.fps !== null && Math.abs(stats.fps - VIDEO_LIMITS.fps) < 0.5;
  add("frame_rate", "Frame rate", fpsOk ? "pass" : "warn", `${stats.fps ?? "unknown"} fps (expected ${VIDEO_LIMITS.fps}).`);
  if (stats.bitRate !== null) {
    const mbps = stats.bitRate / 1_000_000;
    add("bitrate", "Bitrate", mbps <= 25 ? "pass" : "warn", `${mbps.toFixed(1)} Mbps (keep under 25 Mbps).`);
  }

  if (stats.integratedLufs === null) add("loudness", "Loudness", "warn", "Could not measure integrated loudness.");
  else {
    const ok = stats.integratedLufs >= -16 && stats.integratedLufs <= -12;
    const silent = stats.integratedLufs < -60;
    add("loudness", "Loudness", silent ? "warn" : ok ? "pass" : "warn", silent ? "The video is silent." : `${stats.integratedLufs.toFixed(1)} LUFS integrated (target −14, accepted −16 to −12).`);
  }
  if (stats.truePeakDb !== null) add("true_peak", "True peak", stats.truePeakDb <= -1 ? "pass" : "warn", `${stats.truePeakDb.toFixed(1)} dBTP (keep at or below −1).`);

  const missing = t.scenes.map((s, i) => (s.visual ? null : i + 1)).filter((x): x is number => x !== null);
  add("media", "Media in every scene", missing.length ? "fail" : "pass", missing.length ? `Scene(s) ${missing.join(", ")} have no media (rendered as black).` : "Every scene has a clip or image.");

  const overflow = overflowingText(t);
  add("text_fit", "Text fits safe zones", overflow.length ? "warn" : "pass", overflow.length ? overflow.slice(0, 5).map((o) => o.detail).join(" · ") : "On-screen text and captions stay inside the safe zones.");
  const collide = t.captions.enabled && t.captions.burn_in && t.captions.position === "bottom" && t.scenes.some((s) => s.text?.position === "bottom");
  if (collide) add("text_overlap", "Text overlap", "warn", "Bottom on-screen text and bottom captions may overlap.");

  if (t.voiceover || t.scenes.some((s) => s.voice)) {
    add("voice_gaps", "Voiceover continuity", input.gaps.length ? "warn" : "pass", input.gaps.length ? `Silence over 2s at ${input.gaps.slice(0, 5).map((g) => `${g.from}–${g.to}s`).join(", ")}.` : "No long silences in the voiceover.");
  }
  if (t.captions.enabled && t.captions.lines.length === 0) add("captions", "Captions", "warn", "Captions are enabled but empty — generate them first.");
  add("script_sync", "Script up to date", input.scriptChanged ? "warn" : "pass", input.scriptChanged ? "The script changed after this video was created. Review “Update from script”." : "Matches the script version used.");

  const overall: CheckStatus = items.some((i) => i.status === "fail") ? "fail" : items.some((i) => i.status === "warn") ? "warn" : "pass";
  return { overall, items };
}

/** Credits for a render (decision D2). Mirrors public.render_credit_cost(). */
export function renderCredits(kind: "draft" | "final", seconds: number): number {
  if (kind !== "final") return 0;
  return 3 + Math.max(0, Math.ceil((Math.max(seconds, 0) - 60) / 30));
}
