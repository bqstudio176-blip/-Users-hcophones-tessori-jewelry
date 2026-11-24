import type { SceneBoundary } from "./media/scenes";
import type { TranscriptSegment } from "./transcription/types";

/** Transcript text spoken during each scene (segments overlapping the scene window). */
export function transcriptForScene(scene: Pick<SceneBoundary, "startMs" | "endMs">, segments: TranscriptSegment[]): string {
  return segments
    .filter((s) => s.endMs > scene.startMs && s.startMs < scene.endMs)
    .map((s) => s.text.trim())
    .join(" ")
    .trim();
}

export interface EditingFacts {
  sceneCount: number;
  averageSceneSeconds: number;
  shortestSceneSeconds: number;
  longestSceneSeconds: number;
  cutsPerMinute: number;
  speechCoverage: number | null; // fraction of runtime with transcript segments
  firstCutSeconds: number | null;
}

/** Measured facts derived from processing — no AI involved. */
export function computeEditingFacts(scenes: SceneBoundary[], durationSeconds: number, segments: TranscriptSegment[] | null): EditingFacts {
  const durations = scenes.map((s) => (s.endMs - s.startMs) / 1000);
  const round = (n: number) => Math.round(n * 100) / 100;
  let speech: number | null = null;
  if (segments && durationSeconds > 0) {
    const ms = segments.reduce((sum, s) => sum + Math.max(0, s.endMs - s.startMs), 0);
    speech = round(Math.min(1, ms / (durationSeconds * 1000)));
  }
  return {
    sceneCount: scenes.length,
    averageSceneSeconds: durations.length ? round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
    shortestSceneSeconds: durations.length ? round(Math.min(...durations)) : 0,
    longestSceneSeconds: durations.length ? round(Math.max(...durations)) : 0,
    cutsPerMinute: durationSeconds > 0 ? round(((scenes.length - 1) / durationSeconds) * 60) : 0,
    speechCoverage: speech,
    firstCutSeconds: scenes.length > 1 ? round(scenes[1]!.startMs / 1000) : null,
  };
}

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
