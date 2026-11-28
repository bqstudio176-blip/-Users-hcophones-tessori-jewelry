import { z } from "zod";

/**
 * Video Studio timeline (schema_version 1). One track of scenes derived from a
 * Script Lab script, plus voiceover, music and captions. The database checks
 * structure, limits and asset ownership again (_video_check_timeline,
 * _video_sync_assets); this module validates everything else.
 */
export const VIDEO_FORMATS = {
  vertical: { width: 1080, height: 1920, label: "9:16 · Reels" },
  square: { width: 1080, height: 1080, label: "1:1 · Square" },
  portrait: { width: 1080, height: 1350, label: "4:5 · Portrait" },
} as const;
export type VideoFormat = keyof typeof VIDEO_FORMATS;

export const VIDEO_LIMITS = {
  maxOutputSeconds: 180, // D4
  maxScenes: 60,
  minSceneSeconds: 0.5,
  maxSceneSeconds: 60,
  maxAssetBytes: 1024 ** 3, // D3
  maxAssetSeconds: 600,
  crossfadeSeconds: 0.5,
  fps: 30,
} as const;

export const TEXT_STYLES = [
  { id: "bold", label: "Bold" },
  { id: "clean", label: "Clean" },
  { id: "boxed", label: "Boxed" },
  { id: "outline", label: "Outline" },
  { id: "minimal", label: "Minimal" },
] as const;
export const CAPTION_STYLES = [
  { id: "clean", label: "Clean" },
  { id: "bold_box", label: "Bold box" },
  { id: "highlight", label: "Highlight current word" },
  { id: "minimal", label: "Minimal" },
  { id: "outline", label: "Outline" },
] as const;

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const sceneKey = z.string().regex(/^[a-z0-9_-]{1,40}$/);
const seconds = z.number().finite().min(0).max(3600);

export const Visual = z.object({
  asset_id: uuid,
  kind: z.enum(["video", "image"]),
  trim_start: seconds,
  fit: z.enum(["fill", "fit_blur"]),
  focal_x: z.number().min(0).max(1),
  focal_y: z.number().min(0).max(1),
  ken_burns: z.boolean(),
  volume: z.number().min(0).max(1),
});
export const Voice = z.object({ asset_id: uuid, take_id: uuid.nullable(), volume: z.number().min(0).max(2) });
export const Overlay = z.object({
  content: z.string().max(300),
  style: z.enum(TEXT_STYLES.map((s) => s.id) as [string, ...string[]]),
  position: z.enum(["top", "center", "bottom"]),
});
export const Word = z.object({ start: seconds, end: seconds, text: z.string().max(100) });
export const CaptionLine = z.object({ start: seconds, end: seconds, text: z.string().max(200), words: z.array(Word).max(60).optional() });

export const Scene = z.object({
  id: sceneKey,
  script_scene_id: uuid.nullable(),
  title: z.string().max(200),
  spoken_text: z.string().max(5000),
  duration: z.number().min(VIDEO_LIMITS.minSceneSeconds).max(VIDEO_LIMITS.maxSceneSeconds),
  visual: Visual.nullable(),
  voice: Voice.nullable(),
  transition: z.enum(["cut", "crossfade"]),
  text: Overlay.nullable(),
});

export const Timeline = z.object({
  schema_version: z.literal(1),
  format: z.enum(["vertical", "square", "portrait"]),
  scenes: z.array(Scene).min(1).max(VIDEO_LIMITS.maxScenes),
  voiceover: z.object({ asset_id: uuid, take_id: uuid.nullable(), volume: z.number().min(0).max(2), offset: seconds }).nullable(),
  music: z
    .object({ asset_id: uuid, start: seconds, volume: z.number().min(0).max(1), fade_in: z.number().min(0).max(10), fade_out: z.number().min(0).max(10), duck: z.boolean() })
    .nullable(),
  captions: z.object({
    enabled: z.boolean(),
    burn_in: z.boolean(),
    style: z.enum(CAPTION_STYLES.map((s) => s.id) as [string, ...string[]]),
    position: z.enum(["bottom", "center", "lower_third"]),
    source: z.enum(["voiceover", "estimated", "manual"]),
    lines: z.array(CaptionLine).max(600),
  }),
});
export type Timeline = z.infer<typeof Timeline>;
export type TimelineScene = z.infer<typeof Scene>;
export type CaptionLine = z.infer<typeof CaptionLine>;
export type Word = z.infer<typeof Word>;

export interface AssetInfo {
  id: string;
  kind: "video" | "image" | "audio";
  status: string;
  duration_seconds: number | null;
  has_audio: boolean | null;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

export function timelineDuration(t: Pick<Timeline, "scenes">): number {
  return round(t.scenes.reduce((n, s) => n + s.duration, 0));
}

/** Absolute start time of every scene. */
export function sceneStarts(t: Pick<Timeline, "scenes">): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const s of t.scenes) {
    out.push(round(acc));
    acc += s.duration;
  }
  return out;
}

/** Every asset id the timeline references. */
export function timelineAssetIds(t: Timeline): string[] {
  const ids = new Set<string>();
  for (const s of t.scenes) {
    if (s.visual) ids.add(s.visual.asset_id);
    if (s.voice) ids.add(s.voice.asset_id);
  }
  if (t.voiceover) ids.add(t.voiceover.asset_id);
  if (t.music) ids.add(t.music.asset_id);
  return [...ids];
}

/**
 * Semantic validation (after zod). Returns human-readable problems; an empty
 * list means the timeline can be saved and rendered.
 */
export function validateTimeline(t: Timeline, assets: Map<string, AssetInfo>): string[] {
  const p: string[] = [];
  const total = timelineDuration(t);
  if (total > VIDEO_LIMITS.maxOutputSeconds) p.push(`The video is ${total.toFixed(1)}s; the maximum is ${VIDEO_LIMITS.maxOutputSeconds}s`);
  const keys = new Set<string>();
  const need = (id: string, label: string, kinds: AssetInfo["kind"][], needsAudio = false) => {
    const a = assets.get(id);
    if (!a) return p.push(`${label}: media not found in this workspace`), null;
    if (a.status !== "ready") return p.push(`${label}: media is still ${a.status.replace("_", " ")}`), null;
    if (!kinds.includes(a.kind)) return p.push(`${label}: expected ${kinds.join(" or ")}, got ${a.kind}`), null;
    if (needsAudio && a.kind === "video" && a.has_audio === false) return p.push(`${label}: this video has no audio track`), null;
    return a;
  };
  t.scenes.forEach((s, i) => {
    const label = `Scene ${i + 1}`;
    if (keys.has(s.id)) p.push(`${label}: duplicate scene id`);
    keys.add(s.id);
    if (s.visual) {
      const a = need(s.visual.asset_id, `${label} visual`, [s.visual.kind]);
      if (a && a.kind === "video" && a.duration_seconds !== null && s.visual.trim_start >= a.duration_seconds) {
        p.push(`${label}: trim start (${s.visual.trim_start}s) is beyond the clip length (${a.duration_seconds}s)`);
      }
    }
    if (s.voice) need(s.voice.asset_id, `${label} voice`, ["audio", "video"], true);
    if (s.transition === "crossfade" && i < t.scenes.length - 1 && (s.duration < 1 || t.scenes[i + 1]!.duration < 1)) {
      p.push(`${label}: crossfades need both scenes to last at least 1s`);
    }
  });
  if (t.voiceover) {
    need(t.voiceover.asset_id, "Voiceover", ["audio", "video"], true);
    if (t.scenes.some((s) => s.voice)) p.push("Use either one voiceover for the whole video or per-scene voice, not both");
    if (t.voiceover.offset >= total) p.push("The voiceover starts after the video ends");
  }
  if (t.music) need(t.music.asset_id, "Music", ["audio", "video"], true);
  let prevEnd = 0;
  t.captions.lines.forEach((l, i) => {
    if (!(l.end > l.start)) p.push(`Caption ${i + 1}: end must be after start`);
    if (l.start + 0.001 < prevEnd) p.push(`Caption ${i + 1} overlaps the previous one`);
    if (l.start >= total) p.push(`Caption ${i + 1} starts after the video ends`);
    prevEnd = l.end;
  });
  return p;
}

// ---------------------------------------------------------------------------
// Construction from a Script Lab script
// ---------------------------------------------------------------------------
export interface ScriptSnapshotScene {
  id: string;
  position: number;
  scene_title: string;
  estimated_duration_seconds: number | string;
  spoken_text: string;
  on_screen_text: string;
}

const clampDuration = (n: number) => Math.min(VIDEO_LIMITS.maxSceneSeconds, Math.max(VIDEO_LIMITS.minSceneSeconds, round(n, 2)));

function sceneFromScript(s: ScriptSnapshotScene, i: number): TimelineScene {
  return {
    id: `s${i + 1}-${s.id.slice(0, 8)}`,
    script_scene_id: s.id,
    title: s.scene_title.slice(0, 200),
    spoken_text: s.spoken_text.slice(0, 5000),
    duration: clampDuration(Number(s.estimated_duration_seconds)),
    visual: null,
    voice: null,
    transition: "cut",
    text: s.on_screen_text.trim() ? { content: s.on_screen_text.trim().slice(0, 300), style: "bold", position: "top" } : null,
  };
}

export function buildInitialTimeline(scenes: ScriptSnapshotScene[], format: VideoFormat): Timeline {
  const ordered = [...scenes].sort((a, b) => a.position - b.position).slice(0, VIDEO_LIMITS.maxScenes);
  const timeline: Timeline = {
    schema_version: 1,
    format,
    scenes: ordered.length ? ordered.map(sceneFromScript) : [{ id: "s1", script_scene_id: null, title: "Scene 1", spoken_text: "", duration: 5, visual: null, voice: null, transition: "cut", text: null }],
    voiceover: null,
    music: null,
    captions: { enabled: true, burn_in: true, style: "clean", position: "bottom", source: "estimated", lines: [] },
  };
  // Keep within the output limit by scaling estimates down proportionally.
  const total = timelineDuration(timeline);
  if (total > VIDEO_LIMITS.maxOutputSeconds) {
    const k = VIDEO_LIMITS.maxOutputSeconds / total;
    timeline.scenes = timeline.scenes.map((s) => ({ ...s, duration: clampDuration(Math.floor(s.duration * k * 100) / 100) }));
  }
  return timeline;
}

export interface ScriptMergeDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Applies a newer script to an existing timeline. Media, voice, transitions
 * and the user's own text edits are kept; only script-derived fields of
 * matching scenes change. Returned with a diff the user confirms first.
 */
export function mergeScriptUpdate(t: Timeline, oldScenes: ScriptSnapshotScene[], newScenes: ScriptSnapshotScene[]): { timeline: Timeline; diff: ScriptMergeDiff } {
  const byScript = new Map(t.scenes.filter((s) => s.script_scene_id).map((s) => [s.script_scene_id!, s]));
  const oldById = new Map(oldScenes.map((s) => [s.id, s]));
  const diff: ScriptMergeDiff = { added: [], removed: [], changed: [] };
  const ordered = [...newScenes].sort((a, b) => a.position - b.position);
  const scenes: TimelineScene[] = [];
  ordered.forEach((ns, i) => {
    const existing = byScript.get(ns.id);
    if (!existing) {
      diff.added.push(ns.scene_title);
      scenes.push(sceneFromScript(ns, i));
      return;
    }
    const old = oldById.get(ns.id);
    const textUntouched = !existing.text || existing.text.content === (old?.on_screen_text ?? "").trim();
    const changed = existing.spoken_text !== ns.spoken_text || existing.title !== ns.scene_title || (textUntouched && (old?.on_screen_text ?? "") !== ns.on_screen_text);
    if (changed) diff.changed.push(ns.scene_title);
    scenes.push({
      ...existing,
      title: ns.scene_title.slice(0, 200),
      spoken_text: ns.spoken_text.slice(0, 5000),
      text: textUntouched ? (ns.on_screen_text.trim() ? { content: ns.on_screen_text.trim().slice(0, 300), style: existing.text?.style ?? "bold", position: existing.text?.position ?? "top" } : null) : existing.text,
    });
  });
  const kept = new Set(ordered.map((s) => s.id));
  for (const s of t.scenes) {
    if (s.script_scene_id && !kept.has(s.script_scene_id)) diff.removed.push(s.title);
    if (!s.script_scene_id) scenes.push(s); // scenes the user added stay
  }
  return { timeline: { ...t, scenes: scenes.slice(0, VIDEO_LIMITS.maxScenes) }, diff };
}

// ---------------------------------------------------------------------------
// Voiceover alignment
// ---------------------------------------------------------------------------
export const normalizeWord = (w: string) => w.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9']/g, "");
export const wordsOf = (text: string) => text.split(/\s+/).map(normalizeWord).filter(Boolean);

/**
 * Sets scene durations from a whole-script voiceover: each scene's share of
 * the script's words is mapped onto the measured word timestamps. Scenes
 * without spoken text keep their duration.
 */
export function alignScenesToWords(t: Timeline, words: Word[], offset = 0): Timeline {
  const counts = t.scenes.map((s) => wordsOf(s.spoken_text).length);
  const totalScript = counts.reduce((a, b) => a + b, 0);
  if (!totalScript || words.length === 0) return t;
  const scale = words.length / totalScript;
  let cursor = 0;
  let elapsed = 0;
  const lastSpoken = counts.reduce((last, c, i) => (c > 0 ? i : last), -1);
  const scenes = t.scenes.map((s, i) => {
    if (counts[i] === 0) {
      elapsed += s.duration;
      return s;
    }
    cursor += counts[i]! * scale;
    const idx = Math.min(words.length - 1, Math.max(0, Math.round(cursor) - 1));
    const boundary = i === lastSpoken ? words[words.length - 1]!.end + offset + 0.4 : (words[idx]!.end + (words[idx + 1]?.start ?? words[idx]!.end)) / 2 + offset;
    const duration = clampDuration(boundary - elapsed);
    elapsed += duration;
    return { ...s, duration };
  });
  return { ...t, scenes };
}

// ---------------------------------------------------------------------------
// Deviation between a voiceover transcript and the script text
// ---------------------------------------------------------------------------
export function scriptDeviation(script: string, spoken: string): { similarity: number; missing: string[]; extra: string[] } {
  const a = wordsOf(script).slice(0, 2000);
  const b = wordsOf(spoken).slice(0, 2000);
  if (!a.length && !b.length) return { similarity: 1, missing: [], extra: [] };
  // LCS table (bounded sizes keep this cheap).
  const dp: Uint16Array[] = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const missing: string[] = [];
  const extra: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) (i++, j++);
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) missing.push(a[i++]!);
    else extra.push(b[j++]!);
  }
  while (i < a.length) missing.push(a[i++]!);
  while (j < b.length) extra.push(b[j++]!);
  const lcs = dp[0]![0]!;
  return { similarity: round((2 * lcs) / (a.length + b.length), 3), missing: missing.slice(0, 50), extra: extra.slice(0, 50) };
}
