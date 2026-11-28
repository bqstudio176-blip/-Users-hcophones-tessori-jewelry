import type { CreativeDb } from "./db";
import { detectInjection, untrustedBlock } from "./sanitize";
import type { ResearchBrief } from "./schemas";

/**
 * Controlled, workspace-scoped context retrieval. Every query filters by
 * workspace_id explicitly AND runs under RLS. Only relevant, size-bounded
 * excerpts are included — never whole histories.
 */
export interface StrategyRow {
  id: string;
  workspace_id: string;
  project_id: string;
  name: string;
  niche: string | null;
  target_audience: string | null;
  objective: string;
  main_topic: string | null;
  tone: string | null;
  platform: string;
  preferred_format: string;
  duration_seconds: number;
  reference_ids: string[];
  manual_topics: string[];
  restrictions: string | null;
  desired_cta: string | null;
  use_content_history: boolean;
  research_brief: ResearchBrief | null;
  selected_rule_ids: string[];
}

export interface ReferenceContext {
  sourceId: string; // R1… (selected) or H1… (history)
  referenceId: string;
  title: string;
  kind: "selected" | "history";
  summary: Record<string, unknown> | null; // validated analysis report excerpts
  transcriptExcerpt: string | null;
  transcriptFull: string | null; // for originality checks only — never sent to the model
  injectionFlags: string[];
}

export interface CreativeContext {
  references: ReferenceContext[];
  previousScripts: { id: string; title: string; hook: string | null }[];
  preferences: { kind: string; scope: string; statement: string }[];
  performanceInsights: never[]; // Phase 4 (analytics) — none recorded yet
}

export function terms(...texts: (string | null | undefined)[]): Set<string> {
  return new Set(texts.flatMap((t) => (t ?? "").toLowerCase().split(/[^a-z0-9áéíóúñü]+/).filter((w) => w.length > 3)));
}

/** Ranks items by keyword overlap with the query; ties keep recency order. Pure and testable. */
export function rankByRelevance<T>(items: T[], text: (item: T) => string, query: Set<string>, limit: number): T[] {
  if (query.size === 0) return items.slice(0, limit);
  return items
    .map((item, i) => ({ item, i, score: [...terms(text(item))].filter((w) => query.has(w)).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

type RefRow = { id: string; title: string; workspace_id: string };
type AnalysisRow = { id: string; reference_id: string; created_at: string };
type ReportRow = { analysis_id: string; sections: Record<string, Record<string, unknown>> };
type TranscriptRow = { id: string; analysis_id: string; full_text: string };

function reportSummary(sections: Record<string, Record<string, unknown>> | undefined) {
  if (!sections) return null;
  const s = sections;
  return {
    main_topic: s.summary?.main_topic,
    content_format: s.summary?.content_format,
    key_takeaways: s.summary?.key_takeaways,
    hook_type: s.hook?.hook_type,
    opening_statement: s.hook?.opening_statement,
    attention_mechanism: s.hook?.attention_mechanism,
    narrative_structure: s.storytelling?.narrative_structure,
    main_message: s.storytelling?.main_message,
    cta: s.cta?.call_to_action,
    cta_placement: s.cta?.placement,
    pacing: (s.editing as { measured?: unknown } | undefined)?.measured,
  };
}

export async function retrieveContext(db: CreativeDb, workspaceId: string, strategy: StrategyRow): Promise<CreativeContext> {
  const query = terms(strategy.main_topic, strategy.niche, strategy.target_audience, ...strategy.manual_topics);
  const selectedIds = strategy.reference_ids.slice(0, 5);

  let historyRefs: RefRow[] = [];
  if (strategy.use_content_history) {
    const analyzed = await db.select<RefRow>("content_references", {
      columns: "id, title, workspace_id",
      eq: { workspace_id: workspaceId, analysis_status: "analyzed" },
      order: { column: "updated_at", ascending: false },
      limit: 40,
    });
    historyRefs = rankByRelevance(analyzed.filter((r) => !selectedIds.includes(r.id)), (r) => r.title, query, 3);
  }
  const selectedRefs = selectedIds.length
    ? await db.select<RefRow>("content_references", { columns: "id, title, workspace_id", eq: { workspace_id: workspaceId }, in: { id: selectedIds } })
    : [];

  const allRefs = [...selectedRefs.map((r) => ({ r, kind: "selected" as const })), ...historyRefs.map((r) => ({ r, kind: "history" as const }))];
  const refIds = allRefs.map((x) => x.r.id);
  const analyses = refIds.length
    ? await db.select<AnalysisRow>("video_analyses", { columns: "id, reference_id, created_at", eq: { workspace_id: workspaceId, status: "completed" }, in: { reference_id: refIds }, order: { column: "created_at", ascending: false } })
    : [];
  const latest = new Map<string, AnalysisRow>();
  for (const a of analyses) if (!latest.has(a.reference_id)) latest.set(a.reference_id, a);
  const analysisIds = [...latest.values()].map((a) => a.id);
  const [reports, transcripts] = analysisIds.length
    ? await Promise.all([
        db.select<ReportRow>("analysis_reports", { columns: "analysis_id, sections", eq: { workspace_id: workspaceId }, in: { analysis_id: analysisIds } }),
        db.select<TranscriptRow>("transcripts", { columns: "id, analysis_id, full_text", eq: { workspace_id: workspaceId }, in: { analysis_id: analysisIds } }),
      ])
    : [[], []];

  let r = 0;
  let h = 0;
  const references: ReferenceContext[] = allRefs.map(({ r: ref, kind }) => {
    const a = latest.get(ref.id);
    const report = a ? reports.find((x) => x.analysis_id === a.id) : undefined;
    const transcript = a ? transcripts.find((x) => x.analysis_id === a.id) : undefined;
    const full = transcript?.full_text ?? null;
    return {
      sourceId: kind === "selected" ? `R${++r}` : `H${++h}`,
      referenceId: ref.id,
      title: ref.title,
      kind,
      summary: reportSummary(report?.sections),
      // Only the opening of the transcript for selected references (hook context); none for history items.
      transcriptExcerpt: kind === "selected" && full ? full.slice(0, 600) : null,
      transcriptFull: full,
      injectionFlags: detectInjection(`${ref.title}\n${full ?? ""}`),
    };
  });

  const scripts = await db.select<{ id: string; title: string; sections: { hook?: string | null }; status: string }>("scripts", {
    columns: "id, title, sections, status",
    eq: { workspace_id: workspaceId },
    order: { column: "updated_at", ascending: false },
    limit: 30,
  });
  const previousScripts = rankByRelevance(scripts, (s) => s.title, query, 3).map((s) => ({ id: s.id, title: s.title, hook: s.sections?.hook ?? null }));

  const preferences = await db.select<{ kind: string; scope: string; statement: string }>("creative_preferences", {
    columns: "kind, scope, statement",
    eq: { workspace_id: workspaceId, approved: true },
    limit: 20,
  });

  return { references, previousScripts, preferences, performanceInsights: [] };
}

/** Renders strategy fields as untrusted user data. */
export function renderStrategy(s: StrategyRow): string {
  const fields: [string, string | number | null][] = [
    ["project_strategy_name", s.name],
    ["niche", s.niche],
    ["target_audience", s.target_audience],
    ["objective", s.objective],
    ["main_topic", s.main_topic],
    ["manual_topics", s.manual_topics.join("; ") || null],
    ["tone", s.tone],
    ["platform", s.platform],
    ["preferred_format", s.preferred_format],
    ["duration_seconds", s.duration_seconds],
    ["restrictions", s.restrictions],
    ["desired_cta", s.desired_cta],
  ];
  return fields
    .filter(([, v]) => v !== null && v !== "")
    .map(([k, v]) => untrustedBlock("user_field", k, String(v), 1500))
    .join("\n");
}

export function renderReferences(refs: ReferenceContext[]): string {
  if (refs.length === 0) return "No analyzed references were provided.";
  return refs
    .map((ref) =>
      untrustedBlock(
        ref.kind === "selected" ? "selected_reference" : "workspace_history",
        ref.sourceId,
        JSON.stringify({ title: ref.title, analysis_summary: ref.summary ?? "not analyzed", transcript_opening: ref.transcriptExcerpt }),
        3000,
      ),
    )
    .join("\n");
}

export function renderPreferences(prefs: CreativeContext["preferences"]): string {
  if (prefs.length === 0) return "No approved workspace preferences.";
  return prefs.map((p, i) => untrustedBlock("approved_preference", `P${i + 1}`, `${p.kind} (${p.scope}): ${p.statement}`, 300)).join("\n");
}

export function renderResearchBrief(brief: ResearchBrief | null): string {
  if (!brief) return "No research brief (no analyzed references).";
  return untrustedBlock("research_brief", "RB", JSON.stringify(brief), 4000);
}
