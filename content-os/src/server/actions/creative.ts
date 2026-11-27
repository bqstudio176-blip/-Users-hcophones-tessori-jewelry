"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getWorkspaceContext } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { fieldErrors, uuidSchema } from "@/lib/validation";
import { ClaudeAnalysisModel, DEFAULT_ANALYSIS_MODEL } from "@/server/analysis/ai/claude";
import { FEEDBACK_REASONS, HOOK_CATEGORIES, OBJECTIVES, PLATFORMS, SCRIPT_FORMATS, SCRIPT_SECTIONS } from "@/server/creative/catalog";
import { supabaseCreativeDb } from "@/server/creative/db";
import {
  applyScriptProposal,
  assessScriptQuality,
  generateHooks,
  generateScript,
  generateStrategyRecommendations,
  proposeScriptEdit,
  type AgentFailure,
  type OrchestratorDeps,
} from "@/server/creative/orchestrator";
import { RULE_CATEGORIES } from "@/server/creative/rules/library";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function creativeModel() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const effort = (["low", "medium", "high"] as const).find((e) => e === process.env.CREATIVE_EFFORT) ?? "medium";
  return new ClaudeAnalysisModel(process.env.CREATIVE_MODEL ?? DEFAULT_ANALYSIS_MODEL, { apiKey: key, effort, fallbacks: process.env.ANTHROPIC_DISABLE_FALLBACKS !== "1" });
}

async function orchestratorDeps(): Promise<OrchestratorDeps> {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  return { db: supabaseCreativeDb(supabase), model: creativeModel(), workspaceId: ctx.workspace.id, userId: ctx.user.id };
}

const failure = (r: AgentFailure): ActionState => ({ status: "error", message: r.message });
const credits = (n: number) => (n > 0 ? ` ${n} credit${n === 1 ? "" : "s"} used.` : "");
const text = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v));
const enumOf = <T extends readonly { id: string }[]>(list: T) => z.enum(list.map((x) => x.id) as [string, ...string[]]);
const ok = (message: string, data?: Record<string, string>): ActionState => ({ status: "success", message, data });

// ---------------------------------------------------------------------------
// Projects and strategies
// ---------------------------------------------------------------------------
export async function createProject(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = z.object({ name: z.string().trim().min(1, "Name the project").max(120), description: text(2000) }).safeParse({ name: fd.get("name") ?? "", description: fd.get("description") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase.from("creative_projects").insert({ workspace_id: ctx.workspace.id, name: parsed.data.name, description: parsed.data.description, created_by: ctx.user.id }).select("id").single();
  if (error || !data) return { status: "error", message: dbErrorMessage(error, "Could not create the project.") };
  const refs = fd.getAll("referenceIds").map(String).filter((r) => uuidSchema.safeParse(r).success);
  revalidatePath("/script-lab");
  redirect(`/script-lab/projects/${data.id}/strategy${refs.length ? `?refs=${refs.join(",")}` : ""}`);
}

export async function archiveProject(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("projectId"));
  const supabase = await createClient();
  await supabase.from("creative_projects").update({ status: fd.get("status") === "active" ? "active" : "archived" }).eq("id", id);
  revalidatePath("/script-lab");
}

const strategySchema = z.object({
  name: z.string().trim().min(1, "Name the strategy").max(120),
  niche: text(120),
  target_audience: text(1000),
  objective: enumOf(OBJECTIVES),
  main_topic: text(300),
  tone: text(80),
  platform: enumOf(PLATFORMS),
  preferred_format: enumOf(SCRIPT_FORMATS),
  duration_seconds: z.coerce.number().int("Whole seconds").min(5, "At least 5 seconds").max(1800, "At most 30 minutes"),
  restrictions: text(2000),
  desired_cta: text(300),
  manual_topics: z.string().max(1000).transform((v) => v.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 10)),
  reference_ids: z.array(uuidSchema).max(10, "Select up to 10 references"),
  use_content_history: z.boolean(),
});

export async function saveStrategy(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const projectId = uuidSchema.safeParse(fd.get("projectId"));
  if (!projectId.success) return { status: "error", message: "Invalid project." };
  const parsed = strategySchema.safeParse({
    name: fd.get("name") ?? "", niche: fd.get("niche") ?? "", target_audience: fd.get("target_audience") ?? "", objective: fd.get("objective"),
    main_topic: fd.get("main_topic") ?? "", tone: fd.get("tone") ?? "", platform: fd.get("platform"), preferred_format: fd.get("preferred_format"),
    duration_seconds: fd.get("duration_seconds"), restrictions: fd.get("restrictions") ?? "", desired_cta: fd.get("desired_cta") ?? "",
    manual_topics: fd.get("manual_topics") ?? "", reference_ids: fd.getAll("reference_ids").map(String), use_content_history: fd.get("use_content_history") === "on",
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const strategyId = fd.get("strategyId");
  if (strategyId) {
    const id = uuidSchema.parse(strategyId);
    const { data, error } = await supabase.from("content_strategies").update(parsed.data).eq("id", id).select("id");
    if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save the strategy.") };
    revalidatePath(`/script-lab/projects/${projectId.data}`);
    redirect(`/script-lab/projects/${projectId.data}?strategy=${id}&saved=1`);
  }
  const { data, error } = await supabase.from("content_strategies").insert({ ...parsed.data, workspace_id: ctx.workspace.id, project_id: projectId.data, created_by: ctx.user.id }).select("id").single();
  if (error || !data) return { status: "error", message: dbErrorMessage(error, "Could not save the strategy.") };
  revalidatePath(`/script-lab/projects/${projectId.data}`);
  redirect(`/script-lab/projects/${projectId.data}?strategy=${data.id}&saved=1`);
}

export async function generateRecommendations(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const strategyId = uuidSchema.safeParse(fd.get("strategyId"));
  if (!strategyId.success) return { status: "error", message: "Invalid strategy." };
  const res = await generateStrategyRecommendations(await orchestratorDeps(), strategyId.data);
  if (!res.ok) return failure(res);
  revalidatePath("/script-lab", "layout");
  return ok(`Generated ${res.ideas} recommendations using ${res.selectedRules.length} selected rules${res.researchSkipped ? " (no analyzed references to research)" : ""}.${credits(res.creditsCharged)}`);
}

export async function toggleIdeaFavorite(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("ideaId"));
  const supabase = await createClient();
  await supabase.from("generated_ideas").update({ is_favorite: fd.get("favorite") === "true" }).eq("id", id);
  revalidatePath("/script-lab", "layout");
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------
export async function generateHooksAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = z.object({
    strategyId: uuidSchema,
    categories: z.array(enumOf(HOOK_CATEGORIES)).min(1, "Choose at least one approach"),
    count: z.coerce.number().int().min(1).max(10),
    instructions: text(1000),
  }).safeParse({ strategyId: fd.get("strategyId"), categories: fd.getAll("categories").map(String), count: fd.get("count") ?? 5, instructions: fd.get("instructions") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const res = await generateHooks(await orchestratorDeps(), { ...parsed.data, instructions: parsed.data.instructions ?? undefined });
  if (!res.ok) return failure(res);
  revalidatePath("/script-lab", "layout");
  return ok(`Generated ${res.hookIds.length} hooks.${credits(res.creditsCharged)}`);
}

export async function updateHook(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const parsed = z.object({ hookId: uuidSchema, text: z.string().trim().min(3, "Too short").max(400) }).safeParse({ hookId: fd.get("hookId"), text: fd.get("text") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error } = await supabase.from("generated_hooks").update({ text: parsed.data.text }).eq("id", parsed.data.hookId).select("id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save the hook.") };
  revalidatePath("/script-lab", "layout");
  return ok("Hook saved.");
}

export async function toggleHookFavorite(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("hookId"));
  const supabase = await createClient();
  await supabase.from("generated_hooks").update({ is_favorite: fd.get("favorite") === "true" }).eq("id", id);
  revalidatePath("/script-lab", "layout");
}

export async function deleteHook(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("hookId"));
  const supabase = await createClient();
  await supabase.from("generated_hooks").delete().eq("id", id);
  revalidatePath("/script-lab", "layout");
}

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------
export async function generateScriptAction(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = z.object({
    strategyId: uuidSchema,
    hookId: z.union([uuidSchema, z.literal("")]).transform((v) => (v === "" ? null : v)),
    format: enumOf(SCRIPT_FORMATS),
    durationSeconds: z.coerce.number().int().min(5, "At least 5 seconds").max(1800),
    tone: text(80),
    instructions: text(1500),
  }).safeParse({ strategyId: fd.get("strategyId"), hookId: fd.get("hookId") ?? "", format: fd.get("format"), durationSeconds: fd.get("durationSeconds"), tone: fd.get("tone") ?? "", instructions: fd.get("instructions") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const res = await generateScript(await orchestratorDeps(), { ...parsed.data, format: parsed.data.format as never, instructions: parsed.data.instructions ?? undefined });
  if (!res.ok) return failure(res);
  revalidatePath("/script-lab", "layout");
  redirect(`/script-lab/scripts/${res.scriptId}?generated=1`);
}

export async function generateAlternative(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("scriptId"));
  if (!id.success) return { status: "error", message: "Invalid script." };
  const supabase = await createClient();
  const { data: s } = await supabase.from("scripts").select("id, strategy_id, hook_id, format, target_duration_seconds, tone").eq("id", id.data).eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (!s?.strategy_id) return { status: "error", message: "Alternatives need a script linked to a strategy." };
  const res = await generateScript(await orchestratorDeps(), { strategyId: s.strategy_id, hookId: s.hook_id, format: s.format, durationSeconds: s.target_duration_seconds, tone: s.tone, parentScriptId: s.id, instructions: String(fd.get("instructions") ?? "").slice(0, 1500) || undefined });
  if (!res.ok) return failure(res);
  revalidatePath("/script-lab", "layout");
  redirect(`/script-lab/scripts/${res.scriptId}?generated=1`);
}

export async function updateScriptMeta(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const parsed = z.object({
    scriptId: uuidSchema,
    title: z.string().trim().min(1, "Title required").max(200),
    tone: text(80),
    status: z.enum(["draft", "approved", "archived"]),
    target_duration_seconds: z.coerce.number().int().min(5).max(1800),
    notes: text(10000),
  }).safeParse({ scriptId: fd.get("scriptId"), title: fd.get("title") ?? "", tone: fd.get("tone") ?? "", status: fd.get("status"), target_duration_seconds: fd.get("target_duration_seconds"), notes: fd.get("notes") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const { scriptId, ...values } = parsed.data;
  const supabase = await createClient();
  const { data: current } = await supabase.from("scripts").select("sections").eq("id", scriptId).maybeSingle();
  const sections = { ...((current?.sections as Record<string, unknown>) ?? {}) };
  for (const s of SCRIPT_SECTIONS) {
    const key = s.id === "transition" ? "transitions" : s.id;
    const v = fd.get(`section_${key}`);
    if (v !== null) sections[key] = String(v).trim().slice(0, 5000) || null;
  }
  const { data, error } = await supabase.from("scripts").update({ ...values, sections }).eq("id", scriptId).select("id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save.") };
  revalidatePath(`/script-lab/scripts/${scriptId}`);
  return ok("Script details saved.");
}

const sceneSchema = z.object({
  sceneId: uuidSchema,
  section: z.enum(SCRIPT_SECTIONS.map((s) => s.id) as [string, ...string[]]),
  scene_title: z.string().trim().min(1, "Title required").max(200),
  estimated_duration_seconds: z.coerce.number().positive("Must be positive").max(600),
  spoken_text: z.string().max(5000),
  visual_direction: z.string().max(2000),
  camera_direction: z.string().max(1000),
  on_screen_text: z.string().max(500),
  audio_direction: z.string().max(1000),
  transition: z.string().max(300),
  creative_purpose: z.string().max(600),
});

export async function updateScene(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const raw = Object.fromEntries(["sceneId", "section", "scene_title", "estimated_duration_seconds", "spoken_text", "visual_direction", "camera_direction", "on_screen_text", "audio_direction", "transition", "creative_purpose"].map((k) => [k, fd.get(k) ?? ""]));
  const parsed = sceneSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const { sceneId, ...values } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.from("script_scenes").update(values).eq("id", sceneId).select("script_id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save the scene.") };
  revalidatePath(`/script-lab/scripts/${data[0]!.script_id}`);
  return ok("Scene saved.");
}

export async function sceneCommand(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const scriptId = uuidSchema.parse(fd.get("scriptId"));
  const sceneId = uuidSchema.parse(fd.get("sceneId"));
  const cmd = String(fd.get("cmd"));
  const supabase = await createClient();
  const { data: scenes } = await supabase.from("script_scenes").select("*").eq("script_id", scriptId).order("position");
  const list = scenes ?? [];
  const idx = list.findIndex((s) => s.id === sceneId);
  if (idx < 0) throw new Error("Scene not found");
  const scene = list[idx]!;
  let error: { code?: string; message: string } | null = null;
  if (cmd === "up" || cmd === "down") {
    const j = cmd === "up" ? idx - 1 : idx + 1;
    if (j >= 0 && j < list.length) {
      const ids = list.map((s) => s.id as string);
      [ids[idx], ids[j]] = [ids[j]!, ids[idx]!];
      ({ error } = await supabase.rpc("reorder_script_scenes", { p_script_id: scriptId, p_scene_ids: ids }));
    }
  } else if (cmd === "duplicate") {
    const { id: _id, position: _p, workspace_id: _w, script_id: _s, created_at: _c, updated_at: _u, is_locked: _l, ...copy } = scene;
    ({ error } = await supabase.rpc("insert_script_scene", { p_script_id: scriptId, p_position: idx + 2, p_scene: { ...copy, scene_title: `${scene.scene_title} (copy)`.slice(0, 200) } }));
  } else if (cmd === "delete") {
    if (scene.is_locked) throw new Error("Unlock the scene before deleting it.");
    ({ error } = await supabase.rpc("delete_script_scene", { p_scene_id: sceneId }));
  } else if (cmd === "lock" || cmd === "unlock") {
    ({ error } = await supabase.from("script_scenes").update({ is_locked: cmd === "lock" }).eq("id", sceneId));
  } else if (cmd === "add_after") {
    ({ error } = await supabase.rpc("insert_script_scene", { p_script_id: scriptId, p_position: idx + 2, p_scene: { scene_title: "New scene", section: scene.section, estimated_duration_seconds: 3 } }));
  }
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath(`/script-lab/scripts/${scriptId}`);
}

export async function saveScriptVersion(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("scriptId"));
  if (!id.success) return { status: "error", message: "Invalid script." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_script_version", { p_script_id: id.data, p_note: String(fd.get("note") ?? "").slice(0, 500) || null });
  if (error) return { status: "error", message: dbErrorMessage(error) };
  revalidatePath(`/script-lab/scripts/${id.data}`, "layout");
  return ok(`Saved as version ${data}.`);
}

export async function restoreScriptVersion(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("scriptId"));
  const version = z.coerce.number().int().min(1).parse(fd.get("version"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_script_version", { p_script_id: id, p_version: version });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath(`/script-lab/scripts/${id}`, "layout");
  redirect(`/script-lab/scripts/${id}?restored=${version}`);
}

export async function proposeEdit(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const parsed = z.object({
    scriptId: uuidSchema,
    op: z.enum(["regenerate_section", "rewrite_selection", "change_tone", "shorten", "expand"]),
    section: z.string().optional(),
    tone: z.string().trim().max(80).optional(),
    instruction: z.string().trim().max(1000).optional(),
    sceneIds: z.array(uuidSchema).max(60),
  }).safeParse({ scriptId: fd.get("scriptId"), op: fd.get("op"), section: (fd.get("section") as string) || undefined, tone: (fd.get("tone") as string) || undefined, instruction: (fd.get("instruction") as string) || undefined, sceneIds: fd.getAll("sceneIds").map(String) });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const res = await proposeScriptEdit(await orchestratorDeps(), parsed.data);
  if (!res.ok) return failure(res);
  revalidatePath(`/script-lab/scripts/${parsed.data.scriptId}`);
  return ok(`Proposal ready: ${res.summary} Review it below before applying.${credits(res.creditsCharged)}`);
}

export async function applyProposal(fd: FormData): Promise<void> {
  const id = uuidSchema.parse(fd.get("scriptId"));
  const res = await applyScriptProposal(await orchestratorDeps(), id);
  if (!res.ok) redirect(`/script-lab/scripts/${id}?proposal_error=${encodeURIComponent(res.message)}`);
  revalidatePath(`/script-lab/scripts/${id}`, "layout");
  redirect(`/script-lab/scripts/${id}?applied=1`);
}

export async function discardProposal(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("scriptId"));
  const supabase = await createClient();
  await supabase.from("scripts").update({ pending_proposal: null }).eq("id", id);
  revalidatePath(`/script-lab/scripts/${id}`);
}

export async function runQualityCheck(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const id = uuidSchema.safeParse(fd.get("scriptId"));
  if (!id.success) return { status: "error", message: "Invalid script." };
  const res = await assessScriptQuality(await orchestratorDeps(), id.data);
  if (!res.ok) return failure(res);
  revalidatePath(`/script-lab/scripts/${id.data}`, "layout");
  redirect(`/script-lab/scripts/${id.data}/quality?report=${res.reportId}`);
}

export async function deleteScript(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("scriptId"));
  const projectId = uuidSchema.parse(fd.get("projectId"));
  const supabase = await createClient();
  const { error } = await supabase.from("scripts").delete().eq("id", id);
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/script-lab", "layout");
  redirect(`/script-lab/projects/${projectId}?deleted=1`);
}

// ---------------------------------------------------------------------------
// Creative rules
// ---------------------------------------------------------------------------
const lines = (max: number) => z.string().max(4000).transform((v) => v.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, max));
const ruleSchema = z.object({
  name: z.string().trim().min(3, "At least 3 characters").max(120),
  category: z.enum(RULE_CATEGORIES.map((c) => c.id) as [string, ...string[]]),
  description: z.string().trim().min(10, "At least 10 characters").max(2000),
  objective: z.string().trim().min(5, "At least 5 characters").max(600),
  application_conditions: lines(10).refine((v) => v.length > 0, "Add at least one condition"),
  avoidance_conditions: lines(10),
  example: z.string().trim().min(5, "Add an example").max(1500),
  recommended_formats: z.array(enumOf(SCRIPT_FORMATS)).min(1, "Choose at least one format"),
  objectives: z.array(enumOf(OBJECTIVES)),
  complexity_level: z.enum(["basic", "intermediate", "advanced"]),
  evidence_type: z.enum(["established_principle", "practitioner_heuristic", "experimental"]),
  evidence_note: text(600),
  tags: z.string().max(400).transform((v) => [...new Set(v.split(",").map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(t)))].slice(0, 12)),
});

function readRule(fd: FormData) {
  return ruleSchema.safeParse({
    name: fd.get("name") ?? "", category: fd.get("category"), description: fd.get("description") ?? "", objective: fd.get("objective") ?? "",
    application_conditions: fd.get("application_conditions") ?? "", avoidance_conditions: fd.get("avoidance_conditions") ?? "", example: fd.get("example") ?? "",
    recommended_formats: fd.getAll("recommended_formats").map(String), objectives: fd.getAll("objectives").map(String),
    complexity_level: fd.get("complexity_level"), evidence_type: fd.get("evidence_type"), evidence_note: fd.get("evidence_note") ?? "", tags: fd.get("tags") ?? "",
  });
}

export async function saveRule(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = readRule(fd);
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const { tags, ...values } = parsed.data;
  if (values.evidence_type === "established_principle" && !values.evidence_note) return { status: "error", fieldErrors: { evidence_note: "Name the principle and its source for established principles" } };
  const supabase = await createClient();
  const ruleId = fd.get("ruleId");
  let id: string;
  if (ruleId) {
    id = uuidSchema.parse(ruleId);
    const { data, error } = await supabase.from("creative_rules").update(values).eq("id", id).select("id");
    if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "You cannot edit this rule.") };
    await supabase.from("creative_rule_tags").delete().eq("rule_id", id);
  } else {
    const slug = `${values.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "rule"}-${crypto.randomUUID().slice(0, 6)}`;
    const { data, error } = await supabase.from("creative_rules").insert({ ...values, slug, workspace_id: ctx.workspace.id, status: fd.get("submit") === "1" ? "pending_approval" : "draft", created_by: ctx.user.id }).select("id").single();
    if (error || !data) return { status: "error", message: dbErrorMessage(error, "Could not create the rule.") };
    id = data.id;
  }
  if (tags.length) await supabase.from("creative_rule_tags").insert(tags.map((tag) => ({ rule_id: id, tag })));
  revalidatePath("/script-lab/rules", "layout");
  redirect(`/script-lab/rules/${id}?saved=1`);
}

export async function setRuleStatus(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("ruleId"));
  const status = z.enum(["draft", "pending_approval", "approved", "disabled"]).parse(fd.get("status"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_creative_rule_status", { p_rule_id: id, p_status: status });
  if (error) redirect(`/script-lab/rules/${id}?error=${encodeURIComponent(dbErrorMessage(error))}`);
  revalidatePath("/script-lab/rules", "layout");
}

export async function setRuleOverride(fd: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("ruleId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_creative_rule_override", { p_workspace_id: ctx.workspace.id, p_rule_id: id, p_enabled: fd.get("enabled") === "true" });
  if (error) redirect(`/script-lab/rules/${id}?error=${encodeURIComponent(dbErrorMessage(error))}`);
  revalidatePath("/script-lab/rules", "layout");
}

// ---------------------------------------------------------------------------
// Feedback and preferences
// ---------------------------------------------------------------------------
export async function submitFeedback(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = z.object({
    target_type: z.enum(["idea", "hook", "script", "recommendation", "quality_report", "strategy"]),
    target_id: uuidSchema,
    target_version: z.union([z.coerce.number().int().min(0), z.literal("")]).transform((v) => (v === "" ? null : v)),
    rating: z.enum(["useful", "not_useful"]),
    reasons: z.array(enumOf(FEEDBACK_REASONS)).max(8),
    comment: text(1000),
  }).safeParse({ target_type: fd.get("target_type"), target_id: fd.get("target_id"), target_version: fd.get("target_version") ?? "", rating: fd.get("rating"), reasons: fd.getAll("reasons").map(String), comment: fd.get("comment") ?? "" });
  if (!parsed.success) return { status: "error", message: "Invalid feedback." };
  const supabase = await createClient();
  const { error } = await supabase.from("script_feedback").insert({ ...parsed.data, workspace_id: ctx.workspace.id, created_by: ctx.user.id });
  if (error) return { status: "error", message: dbErrorMessage(error, "Could not save feedback.") };
  revalidatePath("/script-lab", "layout");
  return ok("Thanks — feedback recorded.");
}

export async function createPreference(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = z.object({
    kind: z.enum(["prefer", "avoid"]),
    scope: z.enum(["tone", "length", "style", "topic", "format", "cta", "storytelling", "other"]),
    statement: z.string().trim().min(3, "Describe the preference").max(300),
  }).safeParse({ kind: fd.get("kind"), scope: fd.get("scope"), statement: fd.get("statement") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const canApprove = ctx.role === "owner" || ctx.role === "admin";
  const supabase = await createClient();
  const { error } = await supabase.from("creative_preferences").insert({ ...parsed.data, workspace_id: ctx.workspace.id, source: fd.get("source") === "feedback_suggestion" ? "feedback_suggestion" : "user", approved: canApprove, created_by: ctx.user.id });
  if (error) return { status: "error", message: dbErrorMessage(error) };
  revalidatePath("/script-lab/feedback");
  return ok(canApprove ? "Preference saved and active." : "Preference submitted — an owner or admin must approve it before it is used.");
}

export async function setPreferenceApproval(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("preferenceId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_creative_preference_approval", { p_preference_id: id, p_approved: fd.get("approved") === "true" });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/script-lab/feedback");
}

export async function deletePreference(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("preferenceId"));
  const supabase = await createClient();
  await supabase.from("creative_preferences").delete().eq("id", id);
  revalidatePath("/script-lab/feedback");
}
