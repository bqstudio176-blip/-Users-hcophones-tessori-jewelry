import { formatTimestamp } from "./align";
import type { ReportSections } from "./ai/schemas";

export interface ExportInput {
  title: string;
  reference: { url: string | null; source_type: string; author_name: string | null };
  analysis: { id: string; created_at: string; completed_at: string | null; media_metadata: { durationSeconds?: number; video?: { width: number; height: number; fps: number | null } | null } };
  report: { sections: ReportSections; model_provider: string; model_id: string; prompt_versions: Record<string, string>; user_notes: string | null };
  scenes: { idx: number; start_ms: number; end_ms: number; purpose: string | null; editing_notes: string | null; visual: { description?: string; text_overlays?: string[] } | null; transcript_excerpt: string | null }[];
  segments: { start_ms: number; end_ms: number; text: string }[];
}

const t = (sec: number | null | undefined) => (sec === null || sec === undefined ? "—" : formatTimestamp(sec * 1000));
const obsList = (items: { timestamp_sec: number | null; observation: string }[]) =>
  items.length ? items.map((o) => `- [${t(o.timestamp_sec)}] ${o.observation}`).join("\n") : "- None observed";
const esc = (s: string) => s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");

/** Markdown export. Observed facts and AI interpretations are labelled separately. */
export function reportToMarkdown(x: ExportInput): string {
  const s = x.report.sections;
  const m = x.analysis.media_metadata;
  const lines: string[] = [
    `# Analysis report — ${x.title}`,
    "",
    `- Source: ${x.reference.source_type}${x.reference.url ? ` (${x.reference.url})` : ""}${x.reference.author_name ? ` · ${x.reference.author_name}` : ""}`,
    `- Duration: ${m.durationSeconds ? `${m.durationSeconds.toFixed(1)}s` : "—"}${m.video ? ` · ${m.video.width}×${m.video.height}` : ""}`,
    `- Analyzed: ${x.analysis.completed_at ?? x.analysis.created_at} · Model: ${x.report.model_provider}/${x.report.model_id}`,
    `- Inputs: transcript ${s.inputs.transcript}; ${s.inputs.framesAnalyzed} of ${s.inputs.scenesTotal} scene frames analyzed`,
    "",
    "> Observed facts come from the transcript, representative frames and measured scene detection. Interpretations are AI-generated. No audience or performance data was used.",
    "",
    "## Summary",
    `- Main topic: ${s.summary.main_topic}`,
    `- Intended audience: ${s.summary.intended_audience ?? "Not inferable"}`,
    `- Format: ${s.summary.content_format}`,
    `- Objective: ${s.summary.communication_objective}`,
    ...s.summary.key_takeaways.map((k) => `- Takeaway: ${k}`),
    "",
    "## Hook",
    `- Opening statement: ${s.hook.opening_statement ? `“${s.hook.opening_statement}”` : "No speech"}`,
    `- Type: ${s.hook.hook_type} · Estimated duration: ${s.hook.estimated_hook_duration_sec.toFixed(1)}s`,
    `- Attention mechanism: ${s.hook.attention_mechanism}`,
    `- Curiosity element: ${s.hook.curiosity_element ?? "None identified"}`,
    "",
    "**Observed**",
    obsList(s.hook.evidence),
    "",
    `**Interpretation (AI):** ${s.hook.interpretation}`,
    "",
    "## Storytelling",
    `- Structure: ${s.storytelling.narrative_structure} · Main message: ${s.storytelling.main_message}`,
    `- Development: ${s.storytelling.development}`,
    `- Emotional elements: ${s.storytelling.emotional_elements.join(", ") || "None identified"}`,
    "",
    "**Information sequence**",
    ...s.storytelling.information_sequence.map((p) => `- [${t(p.timestamp_sec)}] ${p.point}`),
    "",
    `**Interpretation (AI):** ${s.storytelling.interpretation}`,
    "",
    "## Retention structure",
    "**Structural changes**", obsList(s.retention.structural_changes), "",
    "**Pattern interruptions**", obsList(s.retention.pattern_interruptions), "",
    "**Questions**", obsList(s.retention.questions), "",
    "**Transitions**", obsList(s.retention.transitions), "",
    `- Narrative progression: ${s.retention.narrative_progression}`,
    `**Interpretation (AI):** ${s.retention.interpretation}`,
    "",
    "## Call to action",
    s.cta.present ? `- “${s.cta.call_to_action ?? ""}” · placement ${s.cta.placement} at ${t(s.cta.timestamp_sec)} · intended response: ${s.cta.intended_response ?? "—"}` : "- No call to action identified",
    "",
    "## Editing",
    `- Measured: ${s.editing.measured.sceneCount} scenes · avg ${s.editing.measured.averageSceneSeconds}s · ${s.editing.measured.cutsPerMinute} cuts/min · speech coverage ${s.editing.measured.speechCoverage === null ? "n/a" : `${Math.round(s.editing.measured.speechCoverage * 100)}%`}`,
    `- Text overlays: ${s.editing.observations.text_overlay_usage}`,
    `- Audio structure: ${s.editing.observations.audio_structure}`,
    `- Pacing: ${s.editing.observations.pacing_observations}`,
    "**Visual transitions**", obsList(s.editing.observations.visual_transitions),
    "",
    "## Scenes",
    "| # | Start | End | Purpose | Visual | Speech |",
    "|---|---|---|---|---|---|",
    ...x.scenes.map((sc) => `| ${sc.idx + 1} | ${formatTimestamp(sc.start_ms)} | ${formatTimestamp(sc.end_ms)} | ${esc(sc.purpose ?? "—")} | ${esc(sc.visual?.description ?? "Not analyzed")} | ${esc(sc.transcript_excerpt ?? "—")} |`),
    "",
    "## Creative opportunities (AI)",
    "**Alternative hooks**", ...s.creative.alternative_hooks.map((h) => `- ${h.hook} — ${h.rationale}`), "",
    "**Storytelling approaches**", ...s.creative.storytelling_approaches.map((a) => `- ${a.approach}: ${a.description}`), "",
    "**Original angles**", ...s.creative.original_angles.map((a) => `- ${a.angle}: ${a.why_it_could_work}`), "",
    "**Recommendations**", ...s.creative.recommendations.map((r) => `- ${r}`),
    "",
    "## Transcript",
    ...(x.segments.length ? x.segments.map((sg) => `- [${formatTimestamp(sg.start_ms)}–${formatTimestamp(sg.end_ms)}] ${sg.text}`) : [`- Not available (${s.inputs.transcript})`]),
  ];
  if (x.report.user_notes) lines.push("", "## Notes", x.report.user_notes);
  lines.push("", `---`, `Prompt versions: ${Object.values(x.report.prompt_versions).join(", ")} · Analysis ${x.analysis.id}`);
  return lines.join("\n") + "\n";
}

export function exportFileName(title: string, ext: "md" | "json"): string {
  const slug = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "analysis";
  return `${slug}-analysis.${ext}`;
}
