/**
 * Duration estimates for scripts. These are ESTIMATES from word counts and
 * stated scene lengths — never the actual recorded duration, which is only
 * known after filming (labelled as such in the UI).
 */
export const SPEECH_PACE_WPS = { slow: 2.0, normal: 2.5, fast: 3.0 } as const;
/** Faster than this and speech becomes hard to follow (≈ 190 wpm). */
export const MAX_COMFORTABLE_WPS = 3.2;

export function countWords(text: string): number {
  return (text.trim().match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
}

export function estimateSpeechSeconds(text: string, wps: number = SPEECH_PACE_WPS.normal): number {
  const words = countWords(text);
  return words === 0 ? 0 : Math.round((words / wps) * 10) / 10;
}

export interface SceneDurationInput {
  estimated_duration_seconds: number;
  spoken_text: string;
}

export interface DurationCheck {
  targetSeconds: number;
  estimatedTotalSeconds: number;
  speechOnlySeconds: number;
  deltaSeconds: number;
  deltaPercent: number;
  toleranceSeconds: number;
  status: "within_target" | "too_short" | "too_long";
  overloadedScenes: { index: number; wordsPerSecond: number }[];
}

/** Tolerance: ±15% of the target, but never less than ±3 seconds. */
export function toleranceFor(targetSeconds: number): number {
  return Math.max(3, Math.round(targetSeconds * 0.15 * 10) / 10);
}

export function checkScriptDuration(scenes: SceneDurationInput[], targetSeconds: number): DurationCheck {
  const total = Math.round(scenes.reduce((s, x) => s + Number(x.estimated_duration_seconds || 0), 0) * 10) / 10;
  const speech = Math.round(scenes.reduce((s, x) => s + estimateSpeechSeconds(x.spoken_text), 0) * 10) / 10;
  const tolerance = toleranceFor(targetSeconds);
  const delta = Math.round((total - targetSeconds) * 10) / 10;
  const overloaded = scenes
    .map((s, index) => ({ index, wordsPerSecond: s.estimated_duration_seconds > 0 ? countWords(s.spoken_text) / s.estimated_duration_seconds : Infinity }))
    .filter((x) => x.wordsPerSecond > MAX_COMFORTABLE_WPS)
    .map((x) => ({ ...x, wordsPerSecond: Math.round(x.wordsPerSecond * 100) / 100 }));
  return {
    targetSeconds,
    estimatedTotalSeconds: total,
    speechOnlySeconds: speech,
    deltaSeconds: delta,
    deltaPercent: targetSeconds > 0 ? Math.round((delta / targetSeconds) * 1000) / 10 : 0,
    toleranceSeconds: tolerance,
    status: Math.abs(delta) <= tolerance ? "within_target" : delta < 0 ? "too_short" : "too_long",
    overloadedScenes: overloaded,
  };
}
