import { z } from "zod";

/**
 * Output contracts for every AI step. These schemas are (1) sent to Claude as
 * structured-output formats and (2) re-validated before anything is stored.
 *
 * Convention: `evidence` / `*observations` hold OBSERVED facts tied to a
 * timestamp in the processed media; `interpretation` holds the model's
 * reading of those facts. The UI renders them differently.
 */
export const Observation = z.object({
  timestamp_sec: z.number().nullable().describe("Seconds from the start of the video, or null if not tied to a moment"),
  observation: z.string().describe("A factual observation from the transcript, frames or measured edit data"),
});
export type Observation = z.infer<typeof Observation>;

export const CAMERA_FRAMING = ["extreme_close_up", "close_up", "medium", "wide", "extreme_wide", "screen_recording", "graphic_only", "other"] as const;

export const VisualScene = z.object({
  scene_index: z.number().int(),
  description: z.string(),
  camera_framing: z.enum(CAMERA_FRAMING),
  text_overlays: z.array(z.string()).describe("On-screen text exactly as it appears in the frame; empty if none"),
  visible_objects: z.array(z.string()),
  composition: z.string(),
  on_screen_elements: z.array(z.string()).describe("Captions, stickers, logos, UI, progress bars, etc."),
  people_visible: z.number().int().nullable(),
});
export const VisionBatch = z.object({ scenes: z.array(VisualScene) });
export type VisualScene = z.infer<typeof VisualScene>;

export const HOOK_TYPES = [
  "question", "bold_claim", "curiosity_gap", "problem_statement", "story_opening",
  "visual_pattern_interrupt", "demonstration", "statistic", "direct_address", "other",
] as const;

export const HookAnalysis = z.object({
  opening_statement: z.string().nullable().describe("The first spoken line, verbatim from the transcript; null if there is no speech"),
  hook_type: z.enum(HOOK_TYPES),
  attention_mechanism: z.string(),
  curiosity_element: z.string().nullable(),
  estimated_hook_duration_sec: z.number(),
  evidence: z.array(Observation),
  interpretation: z.string(),
});

export const NARRATIVE_STRUCTURES = [
  "problem_solution", "listicle", "story_arc", "tutorial_steps", "before_after",
  "myth_vs_fact", "day_in_the_life", "reaction_commentary", "other",
] as const;

export const NarrativeAnalysis = z.object({
  storytelling: z.object({
    narrative_structure: z.enum(NARRATIVE_STRUCTURES),
    main_message: z.string(),
    development: z.string(),
    emotional_elements: z.array(z.string()),
    information_sequence: z.array(z.object({ timestamp_sec: z.number().nullable(), point: z.string() })),
    evidence: z.array(Observation),
    interpretation: z.string(),
  }),
  retention: z.object({
    structural_changes: z.array(Observation),
    pattern_interruptions: z.array(Observation),
    questions: z.array(Observation),
    transitions: z.array(Observation),
    narrative_progression: z.string(),
    interpretation: z.string(),
  }),
  cta: z.object({
    present: z.boolean(),
    call_to_action: z.string().nullable(),
    placement: z.enum(["beginning", "middle", "end", "throughout", "none"]),
    timestamp_sec: z.number().nullable(),
    intended_response: z.string().nullable(),
    evidence: z.array(Observation),
  }),
});

export const EditingAnalysis = z.object({
  visual_transitions: z.array(Observation),
  text_overlay_usage: z.string(),
  audio_structure: z.string(),
  pacing_observations: z.string(),
  scene_notes: z.array(z.object({ scene_index: z.number().int(), purpose: z.string(), editing_notes: z.string() })),
  interpretation: z.string(),
});

export const CreativeOpportunities = z.object({
  alternative_hooks: z.array(z.object({ hook: z.string(), rationale: z.string() })),
  storytelling_approaches: z.array(z.object({ approach: z.string(), description: z.string() })),
  original_angles: z.array(z.object({ angle: z.string(), why_it_could_work: z.string() })),
  recommendations: z.array(z.string()),
});

export const ContentSummary = z.object({
  main_topic: z.string(),
  intended_audience: z.string().nullable().describe("Only if it can be inferred from the content; otherwise null"),
  content_format: z.string(),
  communication_objective: z.string(),
  key_takeaways: z.array(z.string()),
});

export type HookAnalysis = z.infer<typeof HookAnalysis>;
export type NarrativeAnalysis = z.infer<typeof NarrativeAnalysis>;
export type EditingAnalysis = z.infer<typeof EditingAnalysis>;
export type CreativeOpportunities = z.infer<typeof CreativeOpportunities>;
export type ContentSummary = z.infer<typeof ContentSummary>;

/** The persisted report (analysis_reports.sections). schema_version = 1. */
export const ReportSections = z.object({
  summary: ContentSummary,
  hook: HookAnalysis,
  storytelling: NarrativeAnalysis.shape.storytelling,
  retention: NarrativeAnalysis.shape.retention,
  cta: NarrativeAnalysis.shape.cta,
  editing: z.object({
    measured: z.object({
      sceneCount: z.number(),
      averageSceneSeconds: z.number(),
      shortestSceneSeconds: z.number(),
      longestSceneSeconds: z.number(),
      cutsPerMinute: z.number(),
      speechCoverage: z.number().nullable(),
      firstCutSeconds: z.number().nullable(),
    }),
    observations: EditingAnalysis.omit({ scene_notes: true }),
  }),
  creative: CreativeOpportunities,
  inputs: z.object({
    transcript: z.enum(["completed", "no_audio", "unavailable", "failed"]),
    scenesTotal: z.number(),
    framesAnalyzed: z.number(),
    durationSeconds: z.number(),
  }),
});
export type ReportSections = z.infer<typeof ReportSections>;

/**
 * Domain checks the JSON schema cannot express: timestamps must fall inside
 * the processed media, scene indices must exist. Returns a list of problems.
 */
export function checkTimestamps(value: unknown, durationSeconds: number, sceneCount?: number): string[] {
  const problems: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "timestamp_sec" || k.endsWith("_duration_sec")) && typeof x === "number" && (x < 0 || x > durationSeconds + 1)) {
          problems.push(`${path}.${k}=${x} is outside 0–${durationSeconds.toFixed(1)}s`);
        }
        if (k === "scene_index" && typeof x === "number" && sceneCount !== undefined && (x < 0 || x >= sceneCount)) {
          problems.push(`${path}.${k}=${x} does not exist`);
        }
        walk(x, `${path}.${k}`);
      }
    }
  };
  walk(value, "$");
  return problems;
}
