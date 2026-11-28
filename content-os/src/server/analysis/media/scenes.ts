import { ANALYSIS_LIMITS } from "../config";
import type { SceneCut } from "./ffmpeg";

export interface SceneBoundary {
  idx: number;
  startMs: number;
  endMs: number;
  /** Score of the cut that opened this scene (null for the first scene). */
  cutScore: number | null;
  /** Timestamp used for the representative frame (scene midpoint). */
  frameTimeMs: number;
}

/**
 * Turns detected cut timestamps into contiguous scenes covering the whole
 * video. Cuts closer than `minSceneSeconds` are merged (keeping the stronger
 * cut). When there are more scenes than `maxScenes`, the weakest cuts are
 * dropped so boundaries always come from real detections.
 */
export function buildScenes(
  cuts: SceneCut[],
  durationSeconds: number,
  opts: { minSceneSeconds?: number; maxScenes?: number } = {},
): SceneBoundary[] {
  const minGap = opts.minSceneSeconds ?? ANALYSIS_LIMITS.minSceneSeconds;
  const maxScenes = opts.maxScenes ?? ANALYSIS_LIMITS.maxScenes;
  if (!(durationSeconds > 0)) return [];

  let valid = cuts
    .filter((c) => c.timeSeconds >= minGap && c.timeSeconds <= durationSeconds - minGap)
    .sort((a, b) => a.timeSeconds - b.timeSeconds);

  const merged: SceneCut[] = [];
  for (const c of valid) {
    const last = merged[merged.length - 1];
    if (last && c.timeSeconds - last.timeSeconds < minGap) {
      if (c.score > last.score) merged[merged.length - 1] = c;
    } else merged.push(c);
  }
  valid = merged;

  if (valid.length > maxScenes - 1) {
    valid = [...valid].sort((a, b) => b.score - a.score).slice(0, maxScenes - 1).sort((a, b) => a.timeSeconds - b.timeSeconds);
  }

  const points = [0, ...valid.map((c) => c.timeSeconds), durationSeconds];
  const scenes: SceneBoundary[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const startMs = Math.round(points[i]! * 1000);
    const endMs = Math.round(points[i + 1]! * 1000);
    if (endMs <= startMs) continue;
    scenes.push({ idx: scenes.length, startMs, endMs, cutScore: i === 0 ? null : valid[i - 1]!.score, frameTimeMs: Math.round((startMs + endMs) / 2) });
  }
  return scenes;
}

/** Picks which scenes get vision analysis when there are more than the budget (spread evenly). */
export function selectScenesForVision(count: number, budget: number): number[] {
  if (count <= budget) return Array.from({ length: count }, (_, i) => i);
  const picked = new Set<number>();
  for (let i = 0; i < budget; i++) picked.add(Math.round((i * (count - 1)) / (budget - 1)));
  return [...picked].sort((a, b) => a - b);
}
