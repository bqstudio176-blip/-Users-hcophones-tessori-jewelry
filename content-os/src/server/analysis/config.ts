/** Processing limits and provider configuration for the analysis worker. */
export const ANALYSIS_LIMITS = {
  maxDurationSeconds: 10 * 60,
  maxFileBytes: 200 * 1024 * 1024,
  sceneThreshold: 0.3, // ffmpeg scene score (0–1) above which a frame starts a new scene
  minSceneSeconds: 0.5,
  maxScenes: 40,
  maxFramesForVision: 24,
  visionBatchSize: 12,
  frameWidth: 640,
  commandTimeoutMs: 5 * 60_000,
} as const;

/** USD per million tokens (first-party Anthropic API). Unknown models → cost not recorded. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
};

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  return Number(((inputTokens * p.input + outputTokens * p.output) / 1_000_000).toFixed(6));
}

export const PIPELINE_STEPS = [
  { id: "validate", label: "Validate input" },
  { id: "media", label: "Process media" },
  { id: "scenes", label: "Detect scenes" },
  { id: "transcription", label: "Transcribe audio" },
  { id: "visual", label: "Analyze frames" },
  { id: "analysis", label: "AI content analysis" },
  { id: "report", label: "Generate report" },
] as const;
export type PipelineStepId = (typeof PIPELINE_STEPS)[number]["id"];
