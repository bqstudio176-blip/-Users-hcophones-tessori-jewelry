import type { z } from "zod";
import type { AnalysisModel, ContentPart, StructuredRequest, StructuredResponse } from "@/server/analysis/ai/provider";
import { InvalidOutputError } from "@/server/analysis/ai/provider";
import type { TranscriptionProvider, TranscriptResult } from "@/server/analysis/transcription/types";

/**
 * MOCK PROVIDERS FOR AUTOMATED TESTS. They return canned, schema-shaped data.
 * They do NOT exercise Claude or Whisper; live verification is tracked
 * separately in TEST_REPORT.md.
 */
export class MockTranscriber implements TranscriptionProvider {
  id = "mock";
  model = "mock-whisper";
  supportsSpeakers = false;
  calls = 0;
  constructor(private behaviour: (call: number) => Promise<TranscriptResult | never> = async () => MOCK_TRANSCRIPT) {}
  async transcribe(): Promise<TranscriptResult> {
    this.calls++;
    return this.behaviour(this.calls);
  }
}

export const MOCK_TRANSCRIPT: TranscriptResult = {
  provider: "mock",
  model: "mock-whisper",
  language: "en",
  text: "Stop scrolling. Here are three colours. Follow for more.",
  durationSeconds: 6,
  segments: [
    { startMs: 0, endMs: 1500, text: "Stop scrolling.", speaker: null, confidence: 0.92 },
    { startMs: 2100, endMs: 3800, text: "Here are three colours.", speaker: null, confidence: 0.88 },
    { startMs: 4200, endMs: 5900, text: "Follow for more.", speaker: null, confidence: 0.9 },
  ],
};

const obs = (t: number | null, o: string) => ({ timestamp_sec: t, observation: o });

function cannedOutput(purpose: string, content: ContentPart[]): unknown {
  switch (purpose) {
    case "visual": {
      const ids = content.filter((p) => p.type === "text").flatMap((p) => (/^Scene (\d+)/.exec((p as { text: string }).text) ? [Number(/^Scene (\d+)/.exec((p as { text: string }).text)![1])] : []));
      return { scenes: ids.map((i) => ({ scene_index: i, description: `Solid colour frame ${i}`, camera_framing: "graphic_only", text_overlays: [], visible_objects: [], composition: "Full-frame flat colour", on_screen_elements: [], people_visible: 0 })) };
    }
    case "hook":
      return { opening_statement: "Stop scrolling.", hook_type: "direct_address", attention_mechanism: "Direct command", curiosity_element: null, estimated_hook_duration_sec: 1.5, evidence: [obs(0, "Speaker says 'Stop scrolling.'")], interpretation: "A direct command used as a pattern interrupt." };
    case "narrative":
      return {
        storytelling: { narrative_structure: "listicle", main_message: "Three colours", development: "One colour per scene", emotional_elements: [], information_sequence: [{ timestamp_sec: 2.1, point: "Introduces colours" }], evidence: [obs(2.1, "'Here are three colours.'")], interpretation: "Simple list format." },
        retention: { structural_changes: [obs(2, "Cut to blue")], pattern_interruptions: [], questions: [], transitions: [obs(4, "Hard cut to green")], narrative_progression: "Linear", interpretation: "Regular hard cuts every 2s." },
        cta: { present: true, call_to_action: "Follow for more.", placement: "end", timestamp_sec: 4.2, intended_response: "Follow the account", evidence: [obs(4.2, "'Follow for more.'")] },
      };
    case "editing":
      return { visual_transitions: [obs(2, "Hard cut"), obs(4, "Hard cut")], text_overlay_usage: "None observed", audio_structure: "Continuous tone with speech", pacing_observations: "Even 2-second scenes", scene_notes: [0, 1, 2].map((i) => ({ scene_index: i, purpose: ["Hook", "Body", "CTA"][i]!, editing_notes: "Static frame" })), interpretation: "Uniform pacing." };
    case "summary":
      return { main_topic: "Colours", intended_audience: null, content_format: "Short-form vertical list", communication_objective: "Demonstrate", key_takeaways: ["Three scenes"] };
    case "creative":
      return { alternative_hooks: [{ hook: "Which colour are you?", rationale: "Invites participation" }], storytelling_approaches: [{ approach: "Quiz", description: "Ask viewers to guess" }], original_angles: [{ angle: "Colour psychology", why_it_could_work: "Educational" }], recommendations: ["Add on-screen text"] };
    default:
      throw new Error(`unknown purpose ${purpose}`);
  }
}

export interface ModelCall {
  purpose: string;
  promptVersion: string;
  images: number;
  imageBytes: number[];
}

export class MockAnalysisModel implements AnalysisModel {
  provider = "mock";
  model = "mock-claude";
  calls: ModelCall[] = [];
  /** Return a value to override the canned output for a given call. */
  constructor(private override?: (purpose: string, callIndexForPurpose: number) => unknown | undefined) {}

  async generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    const images = req.content.filter((p): p is Extract<ContentPart, { type: "image" }> => p.type === "image");
    this.calls.push({ purpose: req.purpose, promptVersion: req.promptVersion, images: images.length, imageBytes: images.map((i) => Buffer.from(i.base64, "base64").length) });
    const n = this.calls.filter((c) => c.purpose === req.purpose).length;
    const raw = this.override?.(req.purpose, n) ?? cannedOutput(req.purpose, req.content);
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) throw new InvalidOutputError(`mock output invalid for ${req.purpose}`, { inputTokens: 10, outputTokens: 5 });
    return { data: parsed.data, servedModel: this.model, inputTokens: 100, outputTokens: 50, latencyMs: 1, costUsd: 0.001 };
  }
}
