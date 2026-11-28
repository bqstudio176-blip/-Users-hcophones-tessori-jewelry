import type { Objective, RuleCategory, ScriptFormat } from "./rules/library";

/**
 * Deterministic, explainable rule selection. Never applies every rule: it
 * filters out rules that don't fit (duration, tone, avoid-preferences),
 * scores the rest against the project context, enforces category diversity
 * and returns a short, reasoned list.
 */
export interface SelectableRule {
  id: string;
  slug: string;
  name: string;
  category: RuleCategory;
  recommended_formats: ScriptFormat[];
  objectives: string[];
  tones_excluded: string[];
  min_duration_seconds: number | null;
  max_duration_seconds: number | null;
  evidence_type: string;
  tags: string[];
}

export interface SelectionContext {
  objective: Objective;
  format: ScriptFormat;
  durationSeconds: number;
  tone?: string | null;
  niche?: string | null;
  audience?: string | null;
  topic?: string | null;
  /** Signals from analyzed references, e.g. hook types and narrative structures observed. */
  sourceSignals?: string[];
  /** Tags/keywords from approved workspace preferences. */
  preferTags?: string[];
  avoidTags?: string[];
  /** Rules the user explicitly pinned or excluded. */
  pinnedRuleIds?: string[];
  excludedRuleIds?: string[];
  focusCategories?: RuleCategory[];
  limit?: number;
  maxPerCategory?: number;
}

export interface SelectedRule {
  rule: SelectableRule;
  score: number;
  reasons: string[];
}

const SIGNAL_TAGS: Record<string, string[]> = {
  question: ["question", "participation"],
  bold_claim: ["claim", "contrarian"],
  curiosity_gap: ["curiosity", "gap"],
  problem_statement: ["mistake", "relatability"],
  story_opening: ["story-opening", "scene"],
  visual_pattern_interrupt: ["scroll-stop", "first-frame"],
  demonstration: ["demonstration", "result"],
  statistic: ["data", "specificity"],
  direct_address: ["audience", "presence"],
  listicle: ["list", "structure"],
  story_arc: ["arc", "structure"],
  tutorial_steps: ["progress", "structure"],
  before_after: ["before-after", "transformation"],
  problem_solution: ["objection", "relatability"],
};

function words(s: string | null | undefined): string[] {
  return (s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
}

export function selectRules(rules: SelectableRule[], ctx: SelectionContext): { selected: SelectedRule[]; consideredCount: number; filteredOut: number } {
  const limit = ctx.limit ?? 10;
  const maxPerCategory = ctx.maxPerCategory ?? 2;
  const tone = (ctx.tone ?? "").toLowerCase().trim();
  const keywords = new Set([...words(ctx.niche), ...words(ctx.audience), ...words(ctx.topic)]);
  const signalTags = new Set((ctx.sourceSignals ?? []).flatMap((s) => SIGNAL_TAGS[s] ?? []));
  const prefer = new Set((ctx.preferTags ?? []).map((t) => t.toLowerCase()));
  const avoid = new Set((ctx.avoidTags ?? []).map((t) => t.toLowerCase()));
  const pinned = new Set(ctx.pinnedRuleIds ?? []);
  const excluded = new Set(ctx.excludedRuleIds ?? []);

  let filteredOut = 0;
  const scored: SelectedRule[] = [];
  for (const rule of rules) {
    if (excluded.has(rule.id)) { filteredOut++; continue; }
    const reasons: string[] = [];
    if (pinned.has(rule.id)) {
      scored.push({ rule, score: 1000, reasons: ["Pinned by you"] });
      continue;
    }
    if (rule.min_duration_seconds !== null && ctx.durationSeconds < rule.min_duration_seconds) { filteredOut++; continue; }
    if (rule.max_duration_seconds !== null && ctx.durationSeconds > rule.max_duration_seconds) { filteredOut++; continue; }
    if (tone && rule.tones_excluded.some((t) => tone.includes(t.toLowerCase()))) { filteredOut++; continue; }
    if (rule.tags.some((t) => avoid.has(t))) { filteredOut++; continue; }

    let score = 0;
    if (rule.objectives.includes(ctx.objective)) { score += 3; reasons.push(`Serves the “${ctx.objective}” objective`); }
    else if (rule.objectives.length === 0) score += 1;
    if (rule.recommended_formats.includes(ctx.format)) { score += 2; reasons.push(`Recommended for ${ctx.format.replace(/_/g, " ")}`); }
    else { score -= 2; }
    const kw = rule.tags.filter((t) => keywords.has(t));
    if (kw.length) { score += Math.min(2, kw.length); reasons.push(`Matches project keywords: ${kw.join(", ")}`); }
    const sig = rule.tags.filter((t) => signalTags.has(t));
    if (sig.length) { score += 2; reasons.push(`Echoes a pattern observed in your analyzed references (${sig.join(", ")})`); }
    const pref = rule.tags.filter((t) => prefer.has(t));
    if (pref.length) { score += 2; reasons.push(`Fits an approved workspace preference (${pref.join(", ")})`); }
    if (ctx.focusCategories?.includes(rule.category)) { score += 2; reasons.push("In a category you are working on"); }
    if (rule.evidence_type === "established_principle") score += 0.5;
    if (rule.evidence_type === "experimental") score -= 0.5;
    if (rule.tags.includes("guardrail")) { score += 1; reasons.push("Guardrail that protects credibility"); }
    if (score > 0 && reasons.length > 0) scored.push({ rule, score, reasons });
    else filteredOut++;
  }

  scored.sort((a, b) => b.score - a.score || a.rule.slug.localeCompare(b.rule.slug));
  const perCategory = new Map<string, number>();
  const selected: SelectedRule[] = [];
  for (const s of scored) {
    if (selected.length >= limit) break;
    const n = perCategory.get(s.rule.category) ?? 0;
    if (s.score < 1000 && n >= maxPerCategory) continue;
    perCategory.set(s.rule.category, n + 1);
    selected.push(s);
  }
  return { selected, consideredCount: rules.length, filteredOut };
}
