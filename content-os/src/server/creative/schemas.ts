import { z } from "zod";

/**
 * Structured output contracts for the five creative agents. Sent to Claude as
 * structured-output formats and re-validated (plus domain checks in
 * validators.ts) before anything is stored.
 *
 * Provenance convention for every recommendation:
 *   observed   → a fact from a provided source id (R1, R2… references/analyses; H1… history)
 *   user       → a field the user provided in the strategy (e.g. target_audience)
 *   hypothesis → the model's own inference (must be labelled as such)
 */
export const Provenance = z.object({
  type: z.enum(["observed", "user", "hypothesis"]),
  source: z.string().nullable().describe("Source id such as R1 for observed; strategy field name for user; null for hypothesis"),
  detail: z.string(),
});
export type Provenance = z.infer<typeof Provenance>;

export const ResearchBrief = z.object({
  summary: z.string(),
  observed_patterns: z.array(z.object({
    pattern: z.string(),
    evidence: z.array(z.object({ source: z.string().describe("Source id, e.g. R1"), detail: z.string() })),
  })),
  gaps: z.array(z.string()).describe("What the research inputs do NOT tell us"),
  cautions: z.array(z.string()).describe("Risks, e.g. not copying a reference's script"),
});
export type ResearchBrief = z.infer<typeof ResearchBrief>;

export const IDEA_KIND_VALUES = ["opportunity", "topic", "angle", "audience_hypothesis", "objective", "format", "approach", "hook_idea", "cta"] as const;
export const StrategyRecommendations = z.object({
  recommendations: z.array(z.object({
    kind: z.enum(IDEA_KIND_VALUES),
    title: z.string(),
    body: z.string(),
    reasoning: z.string(),
    provenance: z.array(Provenance),
  })),
});
export type StrategyRecommendations = z.infer<typeof StrategyRecommendations>;

export const HOOK_CATEGORY_VALUES = [
  "curiosity", "contrarian", "unexpected_information", "problem_identification", "direct_question",
  "story_opening", "educational", "authority", "emotional_connection", "demonstration",
] as const;
export const HookBatch = z.object({
  hooks: z.array(z.object({
    text: z.string(),
    category: z.enum(HOOK_CATEGORY_VALUES),
    mechanism: z.string().describe("Intended psychological mechanism"),
    visual_opening: z.string(),
    delivery: z.string(),
    estimated_duration_seconds: z.number(),
    rationale: z.string(),
    rule_refs: z.array(z.string()).describe("Rule ids from the provided list (K1, K2…) this hook applies"),
  })),
});
export type HookBatch = z.infer<typeof HookBatch>;

export const SECTION_VALUES = ["hook", "opening", "context", "main_development", "supporting_arguments", "transition", "conclusion", "cta"] as const;
export const SceneOut = z.object({
  section: z.enum(SECTION_VALUES),
  scene_title: z.string(),
  estimated_duration_seconds: z.number(),
  spoken_text: z.string(),
  visual_direction: z.string(),
  camera_direction: z.string(),
  on_screen_text: z.string(),
  audio_direction: z.string(),
  transition: z.string(),
  creative_purpose: z.string(),
});
export type SceneOut = z.infer<typeof SceneOut>;

export const ScriptSections = z.object({
  hook: z.string().nullable(),
  opening: z.string().nullable(),
  context: z.string().nullable(),
  main_development: z.string().nullable(),
  supporting_arguments: z.string().nullable(),
  transitions: z.string().nullable(),
  conclusion: z.string().nullable(),
  cta: z.string().nullable(),
});

export const GeneratedScript = z.object({
  title: z.string(),
  sections: ScriptSections,
  scenes: z.array(SceneOut),
  rules_applied: z.array(z.object({ rule_ref: z.string(), how: z.string() })),
  assumptions: z.array(z.string()).describe("Anything assumed because the inputs did not specify it"),
});
export type GeneratedScript = z.infer<typeof GeneratedScript>;

export const ScriptEditProposal = z.object({
  summary_of_changes: z.string(),
  scenes: z.array(SceneOut.extend({ id: z.string().nullable().describe("Existing scene id when the scene is kept or edited; null for a new scene") })),
});
export type ScriptEditProposal = z.infer<typeof ScriptEditProposal>;

export const CRITERION_VALUES = [
  "hook_clarity", "audience_relevance", "narrative_coherence", "story_progression", "originality",
  "clarity", "pacing", "cta_relevance", "format_suitability", "instruction_compliance",
] as const;
export const QualityAssessment = z.object({
  overall_assessment: z.string(),
  criteria: z.array(z.object({ criterion: z.enum(CRITERION_VALUES), score: z.number().int(), explanation: z.string() })),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.object({ scene_number: z.number().int().nullable(), issue: z.string(), explanation: z.string() })),
  suggestions: z.array(z.object({ scene_number: z.number().int().nullable(), suggestion: z.string(), rationale: z.string() })),
});
export type QualityAssessment = z.infer<typeof QualityAssessment>;
