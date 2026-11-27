import type { z } from "zod";
import type { AnalysisModel, ContentPart, StructuredRequest, StructuredResponse } from "@/server/analysis/ai/provider";

/**
 * MOCK CREATIVE MODEL FOR AUTOMATED TESTS. Returns deterministic,
 * schema-shaped outputs per agent. It does not exercise Claude; live
 * verification is tracked in TEST_REPORT.md.
 */
export interface MockCall {
  purpose: string;
  promptVersion: string;
  text: string;
}

const textOf = (content: ContentPart[]) =>
  content
    .filter((p) => p.type === "text")
    .map((p) => (p as { text: string }).text)
    .join("\n");
const ruleRefs = (t: string) => [...t.matchAll(/kind="creative_rule" id="(K\d+)"/g)].map((m) => m[1]!);
const sourceIds = (t: string) => [...t.matchAll(/kind="(?:selected_reference|workspace_history)" id="([RH]\d+)"/g)].map((m) => m[1]!);
const requestedCount = (t: string) => Number(/Write (\d+) hooks/.exec(t)?.[1] ?? 3);
const allowedCats = (t: string) => (/Allowed categories: ([a-z_, ]+)\./.exec(t)?.[1] ?? "curiosity").split(",").map((s) => s.trim());
const targetSeconds = (t: string) => Number(/of about (\d+) seconds/.exec(t)?.[1] ?? 30);

function scene(section: string, title: string, seconds: number, spoken: string) {
  return {
    section,
    scene_title: title,
    estimated_duration_seconds: seconds,
    spoken_text: spoken,
    visual_direction: `Visual for ${title}`,
    camera_direction: "Medium shot",
    on_screen_text: title,
    audio_direction: "Light music bed",
    transition: "Hard cut",
    creative_purpose: `Purpose of ${title}`,
  };
}

export function canned(purpose: string, t: string): unknown {
  const refs = ruleRefs(t);
  const sources = sourceIds(t);
  switch (purpose) {
    case "research":
      return {
        summary: "References open with a direct question and close with a soft CTA.",
        observed_patterns: sources.length ? [{ pattern: "Direct-question hooks", evidence: [{ source: sources[0], detail: "Opens with a question" }] }] : [],
        gaps: ["No audience response data was provided"],
        cautions: ["Do not copy the reference wording"],
      };
    case "strategy": {
      const kinds = ["opportunity", "topic", "angle", "audience_hypothesis", "objective", "format", "approach", "hook_idea", "cta"];
      return {
        recommendations: kinds.map((kind) => ({
          kind,
          title: `${kind} idea`,
          body: `Body for ${kind}`,
          reasoning: `Reasoning for ${kind}`,
          provenance: [
            sources[0] ? { type: "observed", source: sources[0], detail: "Seen in reference" } : { type: "hypothesis", source: null, detail: "Inferred" },
            { type: "user", source: "target_audience", detail: "Stated audience" },
          ],
        })),
      };
    }
    case "hook": {
      const cats = allowedCats(t);
      return {
        hooks: Array.from({ length: requestedCount(t) }, (_, i) => ({
          text: `Hook number ${i + 1}: why most budgets fail in week two`,
          category: cats[i % cats.length],
          mechanism: "Curiosity gap",
          visual_opening: "Close-up of a receipt",
          delivery: "Fast, direct to camera",
          estimated_duration_seconds: 2.5,
          rationale: "Names a common pain",
          rule_refs: refs.slice(0, 1),
        })),
      };
    }
    case "script": {
      const target = targetSeconds(t);
      const per = Math.round((target / 4) * 10) / 10;
      return {
        title: "Why budgets fail in week two",
        sections: { hook: "Why most budgets fail in week two", opening: null, context: "Budgets fail when life happens", main_development: "Plan for irregular costs", supporting_arguments: null, transitions: null, conclusion: "Plan for the irregular", cta: "Save this" },
        scenes: [
          scene("hook", "Hook", per, "Most budgets fail in week two."),
          scene("context", "Context", per, "It is not your willpower. It is the irregular costs."),
          scene("main_development", "Fix", per, "Add a small buffer line for surprises every week."),
          scene("cta", "CTA", per, "Save this for your next budget."),
        ],
        rules_applied: refs.slice(0, 2).map((r) => ({ rule_ref: r, how: "Applied in the hook" })),
        assumptions: ["Audience uses a monthly budget"],
      };
    }
    case "script_edit": {
      const m = /kind="current_script" id="S">\n([\s\S]*?)\n<\/untrusted_data>/.exec(t);
      const scenes = JSON.parse(m![1]!) as Array<Record<string, unknown>>;
      const shorten = /Shorten the script/.test(t);
      return {
        summary_of_changes: shorten ? "Tightened unlocked scenes" : "Rewrote unlocked scenes",
        scenes: scenes.map((s) => {
          const { is_locked: locked, ...rest } = s;
          if (locked) return rest;
          return {
            ...rest,
            spoken_text: `${shorten ? "Short" : "Rewritten"}: ${String(s.spoken_text).split(" ").slice(0, 4).join(" ")}`,
            estimated_duration_seconds: shorten ? Math.max(1, Number(s.estimated_duration_seconds) - 1) : Number(s.estimated_duration_seconds),
          };
        }),
      };
    }
    case "quality": {
      const crit = ["hook_clarity", "audience_relevance", "narrative_coherence", "story_progression", "originality", "clarity", "pacing", "cta_relevance", "format_suitability", "instruction_compliance"];
      return {
        overall_assessment: "Clear and focused; the middle could use a concrete example.",
        criteria: crit.map((c) => ({ criterion: c, score: 4, explanation: `Assessment of ${c}` })),
        strengths: ["Clear hook"],
        weaknesses: [{ scene_number: 3, issue: "Abstract advice", explanation: "No example" }],
        suggestions: [{ scene_number: 3, suggestion: "Add a $20 buffer example", rationale: "Concrete examples aid clarity" }],
      };
    }
  }
  throw new Error(`no canned output for ${purpose}`);
}

export class MockCreativeModel implements AnalysisModel {
  provider = "mock";
  model = "mock-claude";
  calls: MockCall[] = [];
  constructor(private override?: (purpose: string, n: number, text: string) => unknown | Error | undefined) {}
  async generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    const text = textOf(req.content);
    this.calls.push({ purpose: req.purpose, promptVersion: req.promptVersion, text });
    const n = this.calls.filter((c) => c.purpose === req.purpose).length;
    const o = this.override?.(req.purpose, n, text);
    if (o instanceof Error) throw o;
    const raw = o ?? canned(req.purpose, text);
    return { data: req.schema.parse(raw), servedModel: this.model, inputTokens: 1000, outputTokens: 500, latencyMs: 5, costUsd: 0.014 };
  }
}
