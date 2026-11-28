import { describe, expect, it } from "vitest";
import { ReportSections } from "@/server/analysis/ai/schemas";
import { exportFileName, reportToMarkdown, type ExportInput } from "@/server/analysis/report-export";

const obs = (t: number | null, o: string) => ({ timestamp_sec: t, observation: o });
const sections = ReportSections.parse({
  summary: { main_topic: "Colours", intended_audience: null, content_format: "Short list", communication_objective: "Teach", key_takeaways: ["Three scenes"] },
  hook: { opening_statement: "Stop scrolling.", hook_type: "direct_address", attention_mechanism: "Command", curiosity_element: null, estimated_hook_duration_sec: 1.5, evidence: [obs(0, "Says 'Stop scrolling.'")], interpretation: "Pattern interrupt." },
  storytelling: { narrative_structure: "listicle", main_message: "m", development: "d", emotional_elements: [], information_sequence: [{ timestamp_sec: 2, point: "p" }], evidence: [], interpretation: "i" },
  retention: { structural_changes: [obs(2, "Cut")], pattern_interruptions: [], questions: [], transitions: [], narrative_progression: "Linear", interpretation: "r" },
  cta: { present: true, call_to_action: "Follow for more.", placement: "end", timestamp_sec: 4.2, intended_response: "Follow", evidence: [] },
  editing: { measured: { sceneCount: 3, averageSceneSeconds: 2, shortestSceneSeconds: 2, longestSceneSeconds: 2, cutsPerMinute: 20, speechCoverage: 0.85, firstCutSeconds: 2 }, observations: { visual_transitions: [obs(2, "Hard cut")], text_overlay_usage: "None", audio_structure: "Speech", pacing_observations: "Even", interpretation: "Uniform" } },
  creative: { alternative_hooks: [{ hook: "Which colour are you?", rationale: "Participation" }], storytelling_approaches: [], original_angles: [], recommendations: ["Add captions"] },
  inputs: { transcript: "completed", scenesTotal: 3, framesAnalyzed: 3, durationSeconds: 6 },
});

const input: ExportInput = {
  title: "My | Reference",
  reference: { url: "https://www.instagram.com/reel/ABCDE12345/", source_type: "instagram", author_name: null },
  analysis: { id: "a1", created_at: "2026-11-24T10:00:00Z", completed_at: "2026-11-24T10:01:00Z", media_metadata: { durationSeconds: 6, video: { width: 320, height: 240, fps: 25 } } },
  report: { sections, model_provider: "anthropic", model_id: "claude-opus-5-5", prompt_versions: { hook: "hook@1" }, user_notes: "Use the opener." },
  scenes: [{ idx: 0, start_ms: 0, end_ms: 2000, purpose: "Hook", editing_notes: null, visual: { description: "Red | frame" }, transcript_excerpt: "Stop scrolling." }],
  segments: [{ start_ms: 0, end_ms: 1500, text: "Stop scrolling." }],
};

describe("report export", () => {
  const md = reportToMarkdown(input);
  it("includes every report section and labels AI interpretations", () => {
    for (const h of ["## Summary", "## Hook", "## Storytelling", "## Retention structure", "## Call to action", "## Editing", "## Scenes", "## Creative opportunities (AI)", "## Transcript", "## Notes"]) expect(md).toContain(h);
    expect(md).toContain("**Interpretation (AI):** Pattern interrupt.");
    expect(md).toContain("No audience or performance data was used");
  });
  it("keeps timestamps and escapes table cells", () => {
    expect(md).toContain("- [0:00] Says 'Stop scrolling.'");
    expect(md).toContain("- [0:00–0:01] Stop scrolling.");
    expect(md).toContain("Red \\| frame");
  });
  it("produces safe file names", () => {
    expect(exportFileName("My | Réference: 1!", "md")).toBe("my-reference-1-analysis.md");
    expect(exportFileName("!!!", "json")).toBe("analysis-analysis.json");
  });
});
