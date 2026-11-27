import type { z } from "zod";
import { estimateCostUsd } from "@/server/analysis/config";
import { PermanentError, RetryableError } from "@/server/analysis/errors";
import { InvalidOutputError, RefusalError, type AnalysisModel, type ContentPart } from "@/server/analysis/ai/provider";
import { renderPreferences, renderReferences, renderResearchBrief, renderStrategy, retrieveContext, type CreativeContext, type StrategyRow } from "./context";
import { DbError, type CreativeDb } from "./db";
import { CREATIVE_PROMPT_VERSIONS, CREATIVE_SYSTEM_PROMPTS, type CreativeAgentId } from "./prompts";
import type { RuleCategory, ScriptFormat } from "./rules/library";
import { untrustedBlock } from "./sanitize";
import { GeneratedScript, HookBatch, QualityAssessment, ResearchBrief, ScriptEditProposal, StrategyRecommendations } from "./schemas";
import { selectRules, type SelectableRule, type SelectedRule } from "./selection";
import { scriptChecks, validateEditProposal, validateHooks, validateQuality, validateResearchBrief, validateScript, validateStrategy, type CurrentScene, type EditOperation } from "./validators";

/**
 * Creative Orchestrator: validates requests, retrieves workspace-scoped
 * context, selects rules, coordinates the five agents, validates outputs,
 * persists results and records usage (credits only on success).
 */
export interface OrchestratorDeps {
  db: CreativeDb;
  model: AnalysisModel | null;
  workspaceId: string;
  userId: string;
}

export type AgentFailure = {
  ok: false;
  code: "not_configured" | "insufficient_credits" | "rate_limited" | "hourly_limit" | "daily_limit" | "invalid_input" | "invalid_output" | "refused" | "provider_error" | "not_found" | "stale";
  message: string;
};
export type AgentResult<T> = ({ ok: true; creditsCharged: number; runId: string | null } & T) | AgentFailure;

const MESSAGES: Record<string, string> = {
  not_configured: "AI generation is not configured on this deployment (ANTHROPIC_API_KEY).",
  insufficient_credits: "Not enough credits for this generation.",
  rate_limited: "Too many generations in the last minute. Please wait a moment.",
  hourly_limit: "Your workspace reached its hourly AI generation limit.",
  daily_limit: "Your workspace reached its daily AI generation limit.",
};

function fail(code: AgentFailure["code"], message?: string): AgentFailure {
  return { ok: false, code, message: message ?? MESSAGES[code] ?? "The request could not be completed." };
}

interface RunSpec<S extends z.ZodType> {
  agent: CreativeAgentId;
  projectId: string | null;
  content: ContentPart[];
  schema: S;
  validate: (data: z.infer<S>) => string[];
  summary: Record<string, unknown>;
}

type Invocation = { purpose: string; provider: string; model: string; prompt_version: string; status: string; input_tokens: number | null; output_tokens: number | null; latency_ms: number; cost_usd: number | null; error: string | null };

/** One agent call: quota check → model (≤2 attempts on invalid output) → validation → usage record. */
async function runAgent<S extends z.ZodType>(deps: OrchestratorDeps, spec: RunSpec<S>): Promise<AgentResult<{ data: z.infer<S> }>> {
  if (!deps.model) return fail("not_configured");
  const usage = await deps.db.rpc<{ allowed: boolean; reason: string | null }>("check_ai_usage", { p_workspace_id: deps.workspaceId, p_agent: spec.agent });
  if (!usage.allowed) return fail((usage.reason ?? "rate_limited") as AgentFailure["code"]);

  const promptVersion = CREATIVE_PROMPT_VERSIONS[spec.agent];
  const invocations: Invocation[] = [];
  const started = Date.now();
  let data: z.infer<S> | null = null;
  let status: "succeeded" | "failed" | "invalid_output" | "refused" = "failed";
  let error: string | null = null;
  let servedModel = deps.model.model;

  for (let attempt = 1; attempt <= 2 && data === null; attempt++) {
    const t0 = Date.now();
    try {
      const res = await deps.model.generate({ purpose: spec.agent, promptVersion, system: CREATIVE_SYSTEM_PROMPTS[spec.agent], content: spec.content, schema: spec.schema });
      servedModel = res.servedModel;
      const problems = spec.validate(res.data);
      invocations.push({ purpose: spec.agent, provider: deps.model.provider, model: res.servedModel, prompt_version: promptVersion, status: problems.length ? "invalid_output" : "succeeded", input_tokens: res.inputTokens, output_tokens: res.outputTokens, latency_ms: res.latencyMs, cost_usd: res.costUsd, error: problems.length ? problems.slice(0, 5).join("; ").slice(0, 1000) : null });
      if (problems.length) {
        status = "invalid_output";
        error = problems.slice(0, 5).join("; ");
        if (attempt === 1) {
          spec.content = [...spec.content, { type: "text", text: `Your previous answer was rejected by validation: ${error}. Fix these problems and answer again.` }];
        }
        continue;
      }
      data = res.data;
      status = "succeeded";
      error = null;
    } catch (e) {
      const usageInfo = e instanceof InvalidOutputError ? e.usage : undefined;
      const st = e instanceof RefusalError ? "refused" : e instanceof InvalidOutputError ? "invalid_output" : "failed";
      invocations.push({ purpose: spec.agent, provider: deps.model.provider, model: deps.model.model, prompt_version: promptVersion, status: st, input_tokens: usageInfo?.inputTokens ?? null, output_tokens: usageInfo?.outputTokens ?? null, latency_ms: Date.now() - t0, cost_usd: null, error: (e as Error).message.slice(0, 1000) });
      status = st;
      error = (e as Error).message;
      if (e instanceof InvalidOutputError) continue; // one more attempt
      break; // refusals, auth and provider errors are not retried inline
    }
  }

  const inputTokens = invocations.reduce((n, i) => n + (i.input_tokens ?? 0), 0);
  const outputTokens = invocations.reduce((n, i) => n + (i.output_tokens ?? 0), 0);
  const costs = invocations.map((i) => i.cost_usd);
  const cost = costs.every((c) => c !== null) ? costs.reduce((n, c) => n + (c ?? 0), 0) : estimateCostUsd(servedModel, inputTokens, outputTokens);

  let recorded: { run_id: string; credits_charged: number };
  try {
    recorded = await deps.db.rpc("record_ai_agent_run", {
      p_workspace_id: deps.workspaceId,
      p_project_id: spec.projectId,
      p_agent: spec.agent,
      p_status: status,
      p_provider: deps.model.provider,
      p_model: servedModel,
      p_prompt_version: promptVersion,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_duration_ms: Date.now() - started,
      p_cost_usd: cost,
      p_error: error ? error.slice(0, 1000) : null,
      p_request_summary: spec.summary,
      p_invocations: invocations,
    });
  } catch (e) {
    if (e instanceof DbError && e.code === "P0001") return fail("insufficient_credits"); // output discarded: never free
    throw e;
  }

  if (status === "succeeded" && data !== null) return { ok: true, data, creditsCharged: recorded.credits_charged, runId: recorded.run_id };
  if (status === "refused") return fail("refused", "The AI provider declined this request. No credits were charged.");
  if (status === "invalid_output") return fail("invalid_output", `The AI response failed validation twice and was discarded. No credits were charged. (${(error ?? "").slice(0, 200)})`);
  const retryable = invocations.length && error && !/credentials|rejected the request/i.test(error);
  return fail("provider_error", `The AI request failed${retryable ? " — please try again" : ""}. No credits were charged.`);
}

// ---------------------------------------------------------------------------
// Shared loading
// ---------------------------------------------------------------------------
const STRATEGY_COLUMNS = "id, workspace_id, project_id, name, niche, target_audience, objective, main_topic, tone, platform, preferred_format, duration_seconds, reference_ids, manual_topics, restrictions, desired_cta, use_content_history, research_brief, selected_rule_ids";

async function loadStrategy(deps: OrchestratorDeps, strategyId: string): Promise<StrategyRow | null> {
  const rows = await deps.db.select<StrategyRow>("content_strategies", { columns: STRATEGY_COLUMNS, eq: { id: strategyId, workspace_id: deps.workspaceId } });
  return rows[0] ?? null;
}

type RuleRow = SelectableRule & { workspace_id: string | null; description: string; objective: string; application_conditions: string[]; avoidance_conditions: string[]; example: string };

/** Enabled rules for the workspace: approved global rules not disabled by override + approved workspace rules. */
export async function loadEnabledRules(db: CreativeDb, workspaceId: string): Promise<RuleRow[]> {
  const rules = await db.select<Omit<RuleRow, "tags">>("creative_rules", {
    columns: "id, workspace_id, slug, name, category, description, objective, application_conditions, avoidance_conditions, example, recommended_formats, objectives, tones_excluded, min_duration_seconds, max_duration_seconds, evidence_type",
    eq: { status: "approved" },
    limit: 1000,
  });
  const scoped = rules.filter((r) => r.workspace_id === null || r.workspace_id === workspaceId);
  const overrides = await db.select<{ rule_id: string; enabled: boolean }>("creative_rule_overrides", { columns: "rule_id, enabled", eq: { workspace_id: workspaceId } });
  const disabled = new Set(overrides.filter((o) => !o.enabled).map((o) => o.rule_id));
  const ids = scoped.map((r) => r.id);
  const tags = ids.length ? await db.select<{ rule_id: string; tag: string }>("creative_rule_tags", { columns: "rule_id, tag", in: { rule_id: ids } }) : [];
  return scoped.filter((r) => !disabled.has(r.id)).map((r) => ({ ...r, tags: tags.filter((t) => t.rule_id === r.id).map((t) => t.tag) }));
}

function sourceSignals(ctx: CreativeContext): string[] {
  return ctx.references.flatMap((r) => [r.summary?.hook_type, r.summary?.narrative_structure].filter((x): x is string => typeof x === "string"));
}

function preferenceTags(ctx: CreativeContext) {
  const toTags = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 3);
  return {
    preferTags: ctx.preferences.filter((p) => p.kind === "prefer").flatMap((p) => toTags(p.statement)),
    avoidTags: ctx.preferences.filter((p) => p.kind === "avoid").flatMap((p) => toTags(p.statement)),
  };
}

function renderRules(selected: SelectedRule[]): { text: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const text = selected.length
    ? selected
        .map((s, i) => {
          const ref = `K${i + 1}`;
          refs.set(ref, s.rule.id);
          const r = s.rule as RuleRow;
          return untrustedBlock("creative_rule", ref, JSON.stringify({ name: r.name, category: r.category, evidence: r.evidence_type, objective: r.objective, apply_when: r.application_conditions, avoid_when: r.avoidance_conditions, example: r.example, why_selected: s.reasons }), 1500);
        })
        .join("\n")
    : "No creative rules selected.";
  return { text, refs };
}

function selectFor(rules: RuleRow[], strategy: StrategyRow, ctx: CreativeContext, extra: { format?: ScriptFormat; duration?: number; tone?: string | null; focus?: RuleCategory[]; limit?: number } = {}) {
  return selectRules(rules, {
    objective: strategy.objective as never,
    format: (extra.format ?? strategy.preferred_format) as ScriptFormat,
    durationSeconds: extra.duration ?? strategy.duration_seconds,
    tone: extra.tone ?? strategy.tone,
    niche: strategy.niche,
    audience: strategy.target_audience,
    topic: [strategy.main_topic, ...strategy.manual_topics].filter(Boolean).join(" "),
    sourceSignals: sourceSignals(ctx),
    focusCategories: extra.focus,
    limit: extra.limit,
    ...preferenceTags(ctx),
  });
}

const transcriptSources = (ctx: CreativeContext) => ctx.references.filter((r) => r.transcriptFull).map((r) => ({ id: r.sourceId, text: r.transcriptFull! }));

// ---------------------------------------------------------------------------
// Research + Strategy agents
// ---------------------------------------------------------------------------
export async function generateStrategyRecommendations(deps: OrchestratorDeps, strategyId: string): Promise<AgentResult<{ ideas: number; selectedRules: SelectedRule[]; researchSkipped: boolean }>> {
  const strategy = await loadStrategy(deps, strategyId);
  if (!strategy) return fail("not_found", "Strategy not found.");
  if (!deps.model) return fail("not_configured");
  const ctx = await retrieveContext(deps.db, deps.workspaceId, strategy);
  const rules = await loadEnabledRules(deps.db, deps.workspaceId);
  const { selected } = selectFor(rules, strategy, ctx, { limit: 12 });
  const { text: rulesText } = renderRules(selected);
  const sourceIds = new Set(ctx.references.map((r) => r.sourceId));
  let credits = 0;

  // Research Agent — only when there is analyzed material to research.
  let brief: ResearchBrief | null = null;
  const researchable = ctx.references.filter((r) => r.summary);
  if (researchable.length > 0) {
    const research = await runAgent(deps, {
      agent: "research",
      projectId: strategy.project_id,
      schema: ResearchBrief,
      summary: { strategy_id: strategyId, references: researchable.length },
      content: [{ type: "text", text: `Strategy brief:\n${renderStrategy(strategy)}\n\nAnalyzed references:\n${renderReferences(researchable)}` }],
      validate: (b) => validateResearchBrief(b, sourceIds),
    });
    if (!research.ok) return research;
    brief = research.data;
    credits += research.creditsCharged;
  }

  const providedUserFields = new Set(
    Object.entries({ project_strategy_name: strategy.name, niche: strategy.niche, target_audience: strategy.target_audience, objective: strategy.objective, main_topic: strategy.main_topic, manual_topics: strategy.manual_topics.length ? "x" : null, tone: strategy.tone, platform: strategy.platform, preferred_format: strategy.preferred_format, duration_seconds: strategy.duration_seconds, restrictions: strategy.restrictions, desired_cta: strategy.desired_cta })
      .filter(([, v]) => v !== null && v !== "")
      .map(([k]) => k),
  );
  const result = await runAgent(deps, {
    agent: "strategy",
    projectId: strategy.project_id,
    schema: StrategyRecommendations,
    summary: { strategy_id: strategyId, rules: selected.length, references: ctx.references.length },
    content: [{
      type: "text",
      text: [
        `Strategy brief (user-provided):\n${renderStrategy(strategy)}`,
        `Research brief:\n${renderResearchBrief(brief)}`,
        `Workspace history and references (source ids R = selected, H = workspace history):\n${renderReferences(ctx.references)}`,
        `Previous scripts in this workspace (titles only): ${ctx.previousScripts.map((s) => untrustedBlock("previous_script", s.id.slice(0, 8), s.title, 200)).join(" ") || "none"}`,
        `Approved workspace preferences:\n${renderPreferences(ctx.preferences)}`,
        `Recorded performance insights: none available (no analytics data has been recorded).`,
        `Selected creative rules:\n${rulesText}`,
      ].join("\n\n"),
    }],
    validate: (out) => validateStrategy(out, sourceIds, providedUserFields),
  });
  if (!result.ok) return result;
  credits += result.creditsCharged;

  // Map source ids back to real reference ids for storage.
  const refMap = new Map(ctx.references.map((r) => [r.sourceId, { reference_id: r.referenceId, title: r.title }]));
  await deps.db.insert("generated_ideas", result.data.recommendations.map((r) => ({
    workspace_id: deps.workspaceId,
    project_id: strategy.project_id,
    strategy_id: strategy.id,
    agent_run_id: result.runId,
    kind: r.kind,
    title: r.title.slice(0, 300),
    body: r.body.slice(0, 3000) || null,
    reasoning: r.reasoning.slice(0, 3000),
    provenance: r.provenance.map((p) => ({ ...p, ...(p.type === "observed" && p.source ? refMap.get(p.source) : {}) })),
  })));
  await deps.db.update("content_strategies", {
    research_brief: brief,
    recommendations: { generated_at: new Date().toISOString(), agent_run_id: result.runId, count: result.data.recommendations.length, sources: Object.fromEntries(refMap) },
    selected_rule_ids: selected.map((s) => s.rule.id),
  }, { id: strategy.id, workspace_id: deps.workspaceId });

  return { ok: true, creditsCharged: credits, runId: result.runId, ideas: result.data.recommendations.length, selectedRules: selected, researchSkipped: brief === null };
}

// ---------------------------------------------------------------------------
// Hook agent
// ---------------------------------------------------------------------------
export async function generateHooks(deps: OrchestratorDeps, input: { strategyId: string; categories: string[]; count: number; instructions?: string }): Promise<AgentResult<{ hookIds: string[] }>> {
  if (input.count < 1 || input.count > 10) return fail("invalid_input", "Request between 1 and 10 hooks.");
  if (input.categories.length === 0) return fail("invalid_input", "Choose at least one hook approach.");
  const strategy = await loadStrategy(deps, input.strategyId);
  if (!strategy) return fail("not_found", "Strategy not found.");
  if (!deps.model) return fail("not_configured");
  const ctx = await retrieveContext(deps.db, deps.workspaceId, strategy);
  const rules = await loadEnabledRules(deps.db, deps.workspaceId);
  const { selected } = selectFor(rules, strategy, ctx, { focus: ["hooks_openings", "curiosity", "attention_psychology"], limit: 10 });
  const { text: rulesText, refs } = renderRules(selected);

  const result = await runAgent(deps, {
    agent: "hook",
    projectId: strategy.project_id,
    schema: HookBatch,
    summary: { strategy_id: strategy.id, count: input.count, categories: input.categories },
    content: [{
      type: "text",
      text: [
        `Write ${input.count} hooks. Allowed categories: ${input.categories.join(", ")}. Spread them across the allowed categories.`,
        `Strategy brief (user-provided):\n${renderStrategy(strategy)}`,
        input.instructions ? `Extra user instructions:\n${untrustedBlock("user_instructions", "UI", input.instructions, 1000)}` : "",
        `Research brief:\n${renderResearchBrief(strategy.research_brief)}`,
        `References:\n${renderReferences(ctx.references)}`,
        `Approved workspace preferences:\n${renderPreferences(ctx.preferences)}`,
        `Selected creative rules:\n${rulesText}`,
      ].filter(Boolean).join("\n\n"),
    }],
    validate: (out) => validateHooks(out, { count: input.count, categories: input.categories, ruleRefs: new Set(refs.keys()) }),
  });
  if (!result.ok) return result;
  const rows = await deps.db.insert<{ id: string }>("generated_hooks", result.data.hooks.map((h) => ({
    workspace_id: deps.workspaceId,
    project_id: strategy.project_id,
    strategy_id: strategy.id,
    agent_run_id: result.runId,
    text: h.text.trim(),
    original_text: h.text.trim(),
    category: h.category,
    mechanism: h.mechanism,
    visual_opening: h.visual_opening,
    delivery: h.delivery,
    estimated_duration_seconds: Math.round(h.estimated_duration_seconds * 100) / 100,
    rationale: h.rationale,
    rule_ids: h.rule_refs.map((r) => refs.get(r)!).filter(Boolean),
  })));
  return { ok: true, creditsCharged: result.creditsCharged, runId: result.runId, hookIds: rows.map((r) => r.id) };
}

// ---------------------------------------------------------------------------
// Script agent (generation + alternatives)
// ---------------------------------------------------------------------------
export async function generateScript(
  deps: OrchestratorDeps,
  input: { strategyId: string; hookId: string | null; format: ScriptFormat; durationSeconds: number; tone: string | null; instructions?: string; parentScriptId?: string | null },
): Promise<AgentResult<{ scriptId: string }>> {
  if (input.durationSeconds < 5 || input.durationSeconds > 1800) return fail("invalid_input", "Duration must be between 5 seconds and 30 minutes.");
  const strategy = await loadStrategy(deps, input.strategyId);
  if (!strategy) return fail("not_found", "Strategy not found.");
  if (!deps.model) return fail("not_configured");
  type HookRow = { id: string; text: string; category: string; visual_opening: string; delivery: string };
  let hook: HookRow | null = null;
  if (input.hookId) {
    const rows = await deps.db.select<HookRow>("generated_hooks", { columns: "id, text, category, visual_opening, delivery", eq: { id: input.hookId, workspace_id: deps.workspaceId } });
    hook = rows[0] ?? null;
    if (!hook) return fail("not_found", "Hook not found.");
  }
  let parent: { sections: unknown; title: string } | null = null;
  if (input.parentScriptId) {
    const rows = await deps.db.select<{ id: string; title: string; sections: unknown }>("scripts", { columns: "id, title, sections", eq: { id: input.parentScriptId, workspace_id: deps.workspaceId } });
    parent = rows[0] ?? null;
  }
  const ctx = await retrieveContext(deps.db, deps.workspaceId, strategy);
  const rules = await loadEnabledRules(deps.db, deps.workspaceId);
  const { selected } = selectFor(rules, strategy, ctx, { format: input.format, duration: input.durationSeconds, tone: input.tone, limit: 10 });
  const { text: rulesText, refs } = renderRules(selected);
  const sources = transcriptSources(ctx);

  const result = await runAgent(deps, {
    agent: "script",
    projectId: strategy.project_id,
    schema: GeneratedScript,
    summary: { strategy_id: strategy.id, hook_id: input.hookId, format: input.format, duration: input.durationSeconds, alternative_of: input.parentScriptId ?? null },
    content: [{
      type: "text",
      text: [
        `Write a ${input.format.replace(/_/g, " ")} script of about ${input.durationSeconds} seconds${input.tone ? ` in a ${input.tone} tone` : ""}.`,
        hook ? `Selected hook (open with it, adapting only if needed):\n${untrustedBlock("selected_hook", "HK", JSON.stringify(hook), 1200)}` : "No hook selected: write the strongest hook yourself as the first scene.",
        parent ? `This is an ALTERNATIVE version of an existing script. Take a clearly different creative approach while serving the same brief:\n${untrustedBlock("existing_script_outline", "ALT", JSON.stringify(parent), 3000)}` : "",
        input.instructions ? `Extra user instructions:\n${untrustedBlock("user_instructions", "UI", input.instructions, 1500)}` : "",
        `Strategy brief (user-provided):\n${renderStrategy(strategy)}`,
        `Research brief:\n${renderResearchBrief(strategy.research_brief)}`,
        `References (for technique only — do not copy wording):\n${renderReferences(ctx.references)}`,
        `Approved workspace preferences:\n${renderPreferences(ctx.preferences)}`,
        `Selected creative rules:\n${rulesText}`,
      ].filter(Boolean).join("\n\n"),
    }],
    validate: (out) => validateScript(out, { targetSeconds: input.durationSeconds, ruleRefs: new Set(refs.keys()), sources }).problems,
  });
  if (!result.ok) return result;
  const out = result.data;
  const [script] = await deps.db.insert<{ id: string }>("scripts", [{
    workspace_id: deps.workspaceId,
    project_id: strategy.project_id,
    strategy_id: strategy.id,
    hook_id: hook?.id ?? null,
    parent_script_id: input.parentScriptId ?? null,
    title: out.title.slice(0, 200),
    format: input.format,
    target_duration_seconds: input.durationSeconds,
    tone: input.tone,
    rule_ids: out.rules_applied.map((r) => refs.get(r.rule_ref)!).filter(Boolean),
    created_by: deps.userId,
  }]);
  const sections = { ...out.sections, rules_applied: out.rules_applied.map((r) => ({ rule_id: refs.get(r.rule_ref), how: r.how })), assumptions: out.assumptions, agent_run_id: result.runId };
  await deps.db.rpc("replace_script_content", { p_script_id: script!.id, p_title: out.title, p_sections: sections, p_scenes: out.scenes, p_source: "generated", p_note: input.parentScriptId ? "AI alternative" : "AI generated" });
  return { ok: true, creditsCharged: result.creditsCharged, runId: result.runId, scriptId: script!.id };
}

// ---------------------------------------------------------------------------
// Script edit proposals (never applied without explicit confirmation)
// ---------------------------------------------------------------------------
type ScriptRow = { id: string; project_id: string; strategy_id: string | null; title: string; format: ScriptFormat; target_duration_seconds: number; tone: string | null; current_version: number; sections: Record<string, unknown>; pending_proposal: unknown };
const SCENE_COLUMNS = "id, position, section, scene_title, estimated_duration_seconds, spoken_text, visual_direction, camera_direction, on_screen_text, audio_direction, transition, creative_purpose, is_locked";
type SceneRow = CurrentScene & { position: number; camera_direction: string; audio_direction: string; transition: string; creative_purpose: string };

async function loadScript(deps: OrchestratorDeps, scriptId: string) {
  const [script] = await deps.db.select<ScriptRow>("scripts", { columns: "id, project_id, strategy_id, title, format, target_duration_seconds, tone, current_version, sections, pending_proposal", eq: { id: scriptId, workspace_id: deps.workspaceId } });
  if (!script) return null;
  const scenes = await deps.db.select<SceneRow>("script_scenes", { columns: SCENE_COLUMNS, eq: { script_id: scriptId, workspace_id: deps.workspaceId }, order: { column: "position", ascending: true } });
  return { script, scenes: scenes.map((s) => ({ ...s, estimated_duration_seconds: Number(s.estimated_duration_seconds) })) };
}

export async function proposeScriptEdit(
  deps: OrchestratorDeps,
  input: { scriptId: string; op: EditOperation; sceneIds?: string[]; section?: string; instruction?: string; tone?: string },
): Promise<AgentResult<{ summary: string }>> {
  const loaded = await loadScript(deps, input.scriptId);
  if (!loaded) return fail("not_found", "Script not found.");
  if (!deps.model) return fail("not_configured");
  const { script, scenes } = loaded;
  if (input.op === "rewrite_selection" && !input.sceneIds?.length) return fail("invalid_input", "Select at least one scene to rewrite.");
  if (input.op === "regenerate_section" && !input.section) return fail("invalid_input", "Choose a section to regenerate.");
  if (input.op === "change_tone" && !input.tone) return fail("invalid_input", "Choose a tone.");
  const editable = scenes.filter((s) => !s.is_locked);
  if (editable.length === 0) return fail("invalid_input", "All scenes are locked. Unlock a scene to let the AI edit it.");

  let sources: { id: string; text: string }[] = [];
  if (script.strategy_id) {
    const strategy = await loadStrategy(deps, script.strategy_id);
    if (strategy) sources = transcriptSources(await retrieveContext(deps.db, deps.workspaceId, strategy));
  }
  const opText: Record<EditOperation, string> = {
    regenerate_section: `Regenerate the scenes of the “${input.section}” section only.`,
    rewrite_selection: `Rewrite only these scene ids: ${(input.sceneIds ?? []).join(", ")}.`,
    change_tone: `Change the tone of all unlocked scenes to: ${input.tone}.`,
    shorten: `Shorten the script (unlocked scenes only) so the total estimated duration is meaningfully shorter.`,
    expand: `Expand the script (unlocked scenes only) so the total estimated duration is meaningfully longer, adding substance, not filler.`,
  };
  const result = await runAgent(deps, {
    agent: "script_edit",
    projectId: script.project_id,
    schema: ScriptEditProposal,
    summary: { script_id: script.id, op: input.op, base_version: script.current_version },
    content: [{
      type: "text",
      text: [
        `Operation: ${opText[input.op]}`,
        input.instruction ? `User instruction:\n${untrustedBlock("user_instructions", "UI", input.instruction, 1000)}` : "",
        `Script: ${script.format.replace(/_/g, " ")}, target ${script.target_duration_seconds}s, tone ${script.tone ?? "unspecified"}.`,
        `Current scenes (locked scenes must be returned unchanged):\n${untrustedBlock("current_script", "S", JSON.stringify(scenes.map(({ position: _p, ...s }) => s)), 20000)}`,
      ].filter(Boolean).join("\n\n"),
    }],
    validate: (out) => validateEditProposal(out, scenes, { op: input.op, targetSceneIds: input.sceneIds, section: input.section, sources }),
  });
  if (!result.ok) return result;
  // Carry locked flags forward so the RPC can re-verify them on apply.
  const lockedIds = new Set(scenes.filter((s) => s.is_locked).map((s) => s.id));
  const proposal = {
    op: input.op,
    created_at: new Date().toISOString(),
    created_by: deps.userId,
    agent_run_id: result.runId,
    base_version: script.current_version,
    summary: result.data.summary_of_changes,
    scenes: result.data.scenes.map((s) => ({ ...s, is_locked: s.id ? lockedIds.has(s.id) : false })),
  };
  await deps.db.update("scripts", { pending_proposal: proposal }, { id: script.id, workspace_id: deps.workspaceId });
  return { ok: true, creditsCharged: result.creditsCharged, runId: result.runId, summary: proposal.summary };
}

/** Applies a pending AI proposal after explicit confirmation. Rejects stale proposals. */
export async function applyScriptProposal(deps: OrchestratorDeps, scriptId: string): Promise<{ ok: true; version: number } | AgentFailure> {
  const loaded = await loadScript(deps, scriptId);
  if (!loaded) return fail("not_found", "Script not found.");
  const p = loaded.script.pending_proposal as { base_version: number; scenes: unknown[]; summary: string; op: string } | null;
  if (!p) return fail("not_found", "There is no pending proposal.");
  if (p.base_version !== loaded.script.current_version) {
    return fail("stale", "The script changed after this proposal was generated. Discard it and generate a new one so your edits are preserved.");
  }
  const version = await deps.db.rpc<number>("replace_script_content", { p_script_id: scriptId, p_title: loaded.script.title, p_sections: loaded.script.sections, p_scenes: p.scenes, p_source: "ai_edit_applied", p_note: `AI ${p.op.replace(/_/g, " ")}: ${p.summary}`.slice(0, 500) });
  return { ok: true, version };
}

// ---------------------------------------------------------------------------
// Quality agent
// ---------------------------------------------------------------------------
export async function assessScriptQuality(deps: OrchestratorDeps, scriptId: string): Promise<AgentResult<{ reportId: string }>> {
  const loaded = await loadScript(deps, scriptId);
  if (!loaded) return fail("not_found", "Script not found.");
  if (!deps.model) return fail("not_configured");
  const { script, scenes } = loaded;
  let strategy: StrategyRow | null = null;
  let sources: { id: string; text: string }[] = [];
  if (script.strategy_id) {
    strategy = await loadStrategy(deps, script.strategy_id);
    if (strategy) sources = transcriptSources(await retrieveContext(deps.db, deps.workspaceId, strategy));
  }
  const checks = scriptChecks(scenes, script.target_duration_seconds, sources);
  const sectionsUsed = [...new Set(scenes.map((s) => s.section))];
  const deterministic = {
    duration: checks.duration,
    originality: { maxOverlapRatio: checks.originality.ratio, source: checks.originality.sourceId },
    sections_used: sectionsUsed,
    has_hook_first: scenes[0]?.section === "hook",
    has_cta: sectionsUsed.includes("cta"),
    scene_count: scenes.length,
  };
  const result = await runAgent(deps, {
    agent: "quality",
    projectId: script.project_id,
    schema: QualityAssessment,
    summary: { script_id: script.id, version: script.current_version },
    content: [{
      type: "text",
      text: [
        strategy ? `Strategy brief (user-provided):\n${renderStrategy(strategy)}` : "No strategy linked to this script.",
        `Deterministic checks (facts):\n${JSON.stringify(deterministic)}`,
        `Script (${script.format.replace(/_/g, " ")}, target ${script.target_duration_seconds}s, tone ${script.tone ?? "unspecified"}), scenes numbered from 1:\n${untrustedBlock("script_under_review", "S", JSON.stringify(scenes.map((s, i) => ({ scene_number: i + 1, section: s.section, title: s.scene_title, seconds: s.estimated_duration_seconds, spoken: s.spoken_text, visual: s.visual_direction, on_screen: s.on_screen_text }))), 20000)}`,
      ].join("\n\n"),
    }],
    validate: (out) => validateQuality(out, scenes.length),
  });
  if (!result.ok) return result;
  const [row] = await deps.db.insert<{ id: string }>("script_quality_reports", [{
    workspace_id: deps.workspaceId,
    script_id: script.id,
    script_version: script.current_version,
    agent_run_id: result.runId,
    report: result.data,
    checks: deterministic,
    created_by: deps.userId,
  }]);
  return { ok: true, creditsCharged: result.creditsCharged, runId: result.runId, reportId: row!.id };
}

export { PermanentError, RetryableError };
