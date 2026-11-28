import { checkScriptDuration, type DurationCheck } from "./duration";
import { maxTranscriptOverlap, ORIGINALITY_MAX_OVERLAP } from "./originality";
import { containsForbiddenClaim } from "./sanitize";
import { CRITERION_VALUES, IDEA_KIND_VALUES, type GeneratedScript, type HookBatch, type QualityAssessment, type ResearchBrief, type ScriptEditProposal, type StrategyRecommendations } from "./schemas";

/**
 * Domain validation that JSON schemas cannot express. Each validator returns
 * a list of problems; an empty list means the output may be stored.
 */
const USER_FIELDS = new Set(["project_strategy_name", "niche", "target_audience", "objective", "main_topic", "manual_topics", "tone", "platform", "preferred_format", "duration_seconds", "restrictions", "desired_cta"]);

function forbidden(texts: string[], where: string): string[] {
  return texts.some(containsForbiddenClaim) ? [`${where} promises virality or guaranteed results`] : [];
}

export function validateResearchBrief(b: ResearchBrief, sourceIds: Set<string>): string[] {
  const problems: string[] = [];
  for (const p of b.observed_patterns) {
    if (p.evidence.length === 0) problems.push(`Pattern “${p.pattern.slice(0, 40)}” has no evidence`);
    for (const e of p.evidence) if (!sourceIds.has(e.source)) problems.push(`Unknown source id ${e.source}`);
  }
  if (b.observed_patterns.length > 12) problems.push("Too many patterns (max 12)");
  return problems;
}

export function validateStrategy(out: StrategyRecommendations, sourceIds: Set<string>, providedUserFields: Set<string>): string[] {
  const problems: string[] = [];
  for (const kind of IDEA_KIND_VALUES) {
    const n = out.recommendations.filter((r) => r.kind === kind).length;
    if (n === 0) problems.push(`Missing recommendations of kind ${kind}`);
    if (n > 4) problems.push(`Too many recommendations of kind ${kind}`);
  }
  for (const r of out.recommendations) {
    if (!r.title.trim() || r.title.length > 300) problems.push("Recommendation title missing or too long");
    if (!r.reasoning.trim()) problems.push(`“${r.title.slice(0, 30)}” has no reasoning`);
    if (r.provenance.length === 0) problems.push(`“${r.title.slice(0, 30)}” has no provenance`);
    for (const p of r.provenance) {
      if (p.type === "observed" && (!p.source || !sourceIds.has(p.source))) problems.push(`“${r.title.slice(0, 30)}” cites unknown source ${p.source}`);
      if (p.type === "user" && (!p.source || !USER_FIELDS.has(p.source) || !providedUserFields.has(p.source))) problems.push(`“${r.title.slice(0, 30)}” cites a strategy field the user did not provide (${p.source})`);
    }
  }
  return [...problems, ...forbidden(out.recommendations.flatMap((r) => [r.title, r.body, r.reasoning]), "A recommendation")];
}

export function validateHooks(out: HookBatch, opts: { count: number; categories: string[]; ruleRefs: Set<string> }): string[] {
  const problems: string[] = [];
  if (out.hooks.length !== opts.count) problems.push(`Expected ${opts.count} hooks, got ${out.hooks.length}`);
  for (const h of out.hooks) {
    if (h.text.trim().length < 3 || h.text.length > 400) problems.push("Hook text must be 3–400 characters");
    if (!opts.categories.includes(h.category)) problems.push(`Hook category ${h.category} was not requested`);
    if (!(h.estimated_duration_seconds > 0 && h.estimated_duration_seconds <= 30)) problems.push("Hook duration must be between 0 and 30 seconds");
    for (const ref of h.rule_refs) if (!opts.ruleRefs.has(ref)) problems.push(`Unknown rule ref ${ref}`);
    if (h.mechanism.length > 600 || h.visual_opening.length > 600 || h.delivery.length > 400 || h.rationale.length > 1500) problems.push("A hook field is too long");
  }
  return [...problems, ...forbidden(out.hooks.flatMap((h) => [h.text, h.rationale]), "A hook")];
}

export interface ScriptChecks {
  duration: DurationCheck;
  originality: ReturnType<typeof maxTranscriptOverlap>;
}

export function scriptChecks(scenes: { estimated_duration_seconds: number; spoken_text: string }[], targetSeconds: number, sources: { id: string; text: string }[]): ScriptChecks {
  return {
    duration: checkScriptDuration(scenes, targetSeconds),
    originality: maxTranscriptOverlap(scenes.map((s) => s.spoken_text).join(" "), sources),
  };
}

function sceneFieldProblems(s: GeneratedScript["scenes"][number], i: number): string[] {
  const p: string[] = [];
  if (!s.scene_title.trim() || s.scene_title.length > 200) p.push(`Scene ${i + 1}: title missing or too long`);
  if (!(s.estimated_duration_seconds > 0 && s.estimated_duration_seconds <= 600)) p.push(`Scene ${i + 1}: invalid duration`);
  if (s.spoken_text.length > 5000 || s.visual_direction.length > 2000 || s.on_screen_text.length > 500) p.push(`Scene ${i + 1}: a field is too long`);
  return p;
}

export function validateScript(out: GeneratedScript, opts: { targetSeconds: number; ruleRefs: Set<string>; sources: { id: string; text: string }[] }): { problems: string[]; checks: ScriptChecks } {
  const problems: string[] = [];
  if (!out.title.trim() || out.title.length > 200) problems.push("Title missing or too long");
  if (out.scenes.length < 1 || out.scenes.length > 60) problems.push("A script needs 1–60 scenes");
  out.scenes.forEach((s, i) => problems.push(...sceneFieldProblems(s, i)));
  if (out.scenes[0] && out.scenes[0].section !== "hook") problems.push("The first scene must be the hook");
  for (const r of out.rules_applied) if (!opts.ruleRefs.has(r.rule_ref)) problems.push(`Unknown rule ref ${r.rule_ref}`);
  const checks = scriptChecks(out.scenes, opts.targetSeconds, opts.sources);
  if (checks.duration.status !== "within_target") {
    problems.push(`Estimated duration ${checks.duration.estimatedTotalSeconds}s is outside ${opts.targetSeconds}s ±${checks.duration.toleranceSeconds}s`);
  }
  if (checks.duration.overloadedScenes.length) problems.push(`Spoken text is too long for scene(s) ${checks.duration.overloadedScenes.map((s) => s.index + 1).join(", ")}`);
  if (checks.originality.ratio > ORIGINALITY_MAX_OVERLAP) problems.push(`Script reproduces ${Math.round(checks.originality.ratio * 100)}% of a reference transcript`);
  problems.push(...forbidden([out.title, ...out.scenes.map((s) => s.spoken_text), ...out.scenes.map((s) => s.on_screen_text)], "The script"));
  return { problems, checks };
}

export type EditOperation = "regenerate_section" | "rewrite_selection" | "change_tone" | "shorten" | "expand";

export interface CurrentScene {
  id: string;
  section: string;
  scene_title: string;
  estimated_duration_seconds: number;
  spoken_text: string;
  visual_direction: string;
  on_screen_text: string;
  is_locked: boolean;
}

export function validateEditProposal(
  out: ScriptEditProposal,
  current: CurrentScene[],
  opts: { op: EditOperation; targetSceneIds?: string[]; section?: string; sources: { id: string; text: string }[] },
): string[] {
  const problems: string[] = [];
  const byId = new Map(current.map((c) => [c.id, c]));
  const returnedIds = new Set(out.scenes.map((s) => s.id).filter(Boolean) as string[]);
  if (out.scenes.length < 1 || out.scenes.length > 60) problems.push("A script needs 1–60 scenes");
  for (const s of out.scenes) if (s.id && !byId.has(s.id)) problems.push(`Unknown scene id ${s.id}`);
  out.scenes.forEach((s, i) => problems.push(...sceneFieldProblems(s, i)));

  for (const c of current.filter((x) => x.is_locked)) {
    const r = out.scenes.find((s) => s.id === c.id);
    if (!r || r.spoken_text !== c.spoken_text || r.visual_direction !== c.visual_direction || r.on_screen_text !== c.on_screen_text || r.scene_title !== c.scene_title) {
      problems.push(`Locked scene “${c.scene_title}” was changed or removed`);
    }
  }

  const changed = (s: ScriptEditProposal["scenes"][number]) => {
    if (!s.id) return true;
    const c = byId.get(s.id)!;
    return c.spoken_text !== s.spoken_text || c.visual_direction !== s.visual_direction || c.on_screen_text !== s.on_screen_text || c.scene_title !== s.scene_title || Number(c.estimated_duration_seconds) !== s.estimated_duration_seconds;
  };
  if (opts.op === "rewrite_selection" && opts.targetSceneIds?.length) {
    const allowed = new Set(opts.targetSceneIds);
    for (const s of out.scenes) if (s.id && !allowed.has(s.id) && changed(s)) problems.push(`Scene “${s.scene_title}” is outside the selection but was changed`);
    for (const c of current) if (!allowed.has(c.id) && !returnedIds.has(c.id)) problems.push(`Scene “${c.scene_title}” is outside the selection but was removed`);
  }
  if (opts.op === "regenerate_section" && opts.section) {
    for (const s of out.scenes) if (s.id && byId.get(s.id)!.section !== opts.section && changed(s)) problems.push(`Scene “${s.scene_title}” is outside the ${opts.section} section but was changed`);
    for (const c of current) if (c.section !== opts.section && !returnedIds.has(c.id)) problems.push(`Scene “${c.scene_title}” is outside the section but was removed`);
  }
  const before = current.reduce((n, c) => n + Number(c.estimated_duration_seconds), 0);
  const after = out.scenes.reduce((n, s) => n + s.estimated_duration_seconds, 0);
  if (opts.op === "shorten" && after >= before) problems.push("A shortened script must have a shorter estimated duration");
  if (opts.op === "expand" && after <= before) problems.push("An expanded script must have a longer estimated duration");
  const originality = maxTranscriptOverlap(out.scenes.map((s) => s.spoken_text).join(" "), opts.sources);
  if (originality.ratio > ORIGINALITY_MAX_OVERLAP) problems.push(`Proposal reproduces ${Math.round(originality.ratio * 100)}% of a reference transcript`);
  problems.push(...forbidden(out.scenes.map((s) => s.spoken_text), "The proposal"));
  return problems;
}

export function validateQuality(out: QualityAssessment, sceneCount: number): string[] {
  const problems: string[] = [];
  for (const c of CRITERION_VALUES) {
    const n = out.criteria.filter((x) => x.criterion === c).length;
    if (n !== 1) problems.push(`Criterion ${c} must appear exactly once`);
  }
  for (const c of out.criteria) if (c.score < 1 || c.score > 5) problems.push(`Score for ${c.criterion} must be 1–5`);
  for (const x of [...out.weaknesses, ...out.suggestions]) {
    if (x.scene_number !== null && (x.scene_number < 1 || x.scene_number > sceneCount)) problems.push(`Scene ${x.scene_number} does not exist`);
  }
  if (/\b(will|going to) (go viral|get \d|reach \d)|\bpredict(ed|s)? (views|performance)\b/i.test(out.overall_assessment)) problems.push("Assessment presents scores as performance predictions");
  return problems;
}
