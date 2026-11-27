import type { Objective, ScriptFormat } from "./rules/library";

export const SCRIPT_FORMATS: { id: ScriptFormat; label: string }[] = [
  { id: "instagram_reel", label: "Instagram Reel" },
  { id: "educational", label: "Educational" },
  { id: "promotional", label: "Promotional" },
  { id: "storytelling", label: "Storytelling" },
  { id: "talking_head", label: "Talking head" },
  { id: "product_presentation", label: "Product presentation" },
  { id: "list_based", label: "List-based" },
  { id: "tutorial", label: "Tutorial" },
  { id: "opinion", label: "Opinion" },
  { id: "narrative", label: "Narrative" },
];

export const OBJECTIVES: { id: Objective; label: string }[] = [
  { id: "awareness", label: "Awareness" },
  { id: "educate", label: "Educate" },
  { id: "engage", label: "Engagement" },
  { id: "trust", label: "Trust & credibility" },
  { id: "convert", label: "Conversion" },
  { id: "community", label: "Community" },
  { id: "entertain", label: "Entertainment" },
];

export const PLATFORMS = [
  { id: "instagram", label: "Instagram" },
  { id: "tiktok", label: "TikTok" },
  { id: "youtube_shorts", label: "YouTube Shorts" },
  { id: "youtube", label: "YouTube" },
  { id: "linkedin", label: "LinkedIn" },
  { id: "other", label: "Other" },
] as const;

export const HOOK_CATEGORIES = [
  { id: "curiosity", label: "Curiosity" },
  { id: "contrarian", label: "Contrarian" },
  { id: "unexpected_information", label: "Unexpected information" },
  { id: "problem_identification", label: "Problem identification" },
  { id: "direct_question", label: "Direct question" },
  { id: "story_opening", label: "Story opening" },
  { id: "educational", label: "Educational" },
  { id: "authority", label: "Authority" },
  { id: "emotional_connection", label: "Emotional connection" },
  { id: "demonstration", label: "Demonstration" },
] as const;
export type HookCategory = (typeof HOOK_CATEGORIES)[number]["id"];

export const SCRIPT_SECTIONS = [
  { id: "hook", label: "Hook" },
  { id: "opening", label: "Opening" },
  { id: "context", label: "Context" },
  { id: "main_development", label: "Main development" },
  { id: "supporting_arguments", label: "Supporting arguments" },
  { id: "transition", label: "Narrative transitions" },
  { id: "conclusion", label: "Conclusion" },
  { id: "cta", label: "CTA" },
] as const;
export type ScriptSection = (typeof SCRIPT_SECTIONS)[number]["id"];

export const QUALITY_CRITERIA = [
  { id: "hook_clarity", label: "Hook clarity" },
  { id: "audience_relevance", label: "Audience relevance" },
  { id: "narrative_coherence", label: "Narrative coherence" },
  { id: "story_progression", label: "Story progression" },
  { id: "originality", label: "Originality" },
  { id: "clarity", label: "Clarity" },
  { id: "pacing", label: "Pacing" },
  { id: "cta_relevance", label: "CTA relevance" },
  { id: "format_suitability", label: "Format suitability" },
  { id: "instruction_compliance", label: "Instruction compliance" },
] as const;
export type QualityCriterion = (typeof QUALITY_CRITERIA)[number]["id"];

export const FEEDBACK_REASONS = [
  { id: "useful", label: "Useful" },
  { id: "not_relevant", label: "Not relevant" },
  { id: "too_generic", label: "Too generic" },
  { id: "too_long", label: "Too long" },
  { id: "too_commercial", label: "Too commercial" },
  { id: "wrong_tone", label: "Wrong tone" },
  { id: "needs_more_storytelling", label: "Needs more storytelling" },
  { id: "other", label: "Other" },
] as const;
export type FeedbackReason = (typeof FEEDBACK_REASONS)[number]["id"];

export const IDEA_KINDS = [
  { id: "opportunity", label: "Content opportunities" },
  { id: "topic", label: "Suggested topics" },
  { id: "angle", label: "Recommended angles" },
  { id: "audience_hypothesis", label: "Audience hypotheses" },
  { id: "objective", label: "Communication objectives" },
  { id: "format", label: "Suggested formats" },
  { id: "approach", label: "Creative approaches" },
  { id: "hook_idea", label: "Potential hooks" },
  { id: "cta", label: "Suggested CTAs" },
] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number]["id"];

export const labelOf = <T extends { id: string; label: string }>(list: readonly T[], id: string | null | undefined) =>
  list.find((x) => x.id === id)?.label ?? id ?? "—";

export const RULE_CATEGORIES_LABELS: Record<string, string> = {
  attention_psychology: "Psychology of attention",
  hooks_openings: "Hooks and openings",
  storytelling: "Storytelling",
  audience_retention: "Audience retention",
  curiosity: "Curiosity",
  emotional_connection: "Emotional connection",
  authority_credibility: "Authority and credibility",
  persuasion: "Persuasion",
  conversion: "Conversion",
  calls_to_action: "Calls to action",
};
