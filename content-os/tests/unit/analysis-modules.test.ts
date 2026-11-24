import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { computeEditingFacts, formatTimestamp, transcriptForScene } from "@/server/analysis/align";
import { ClaudeAnalysisModel } from "@/server/analysis/ai/claude";
import { InvalidOutputError, RefusalError } from "@/server/analysis/ai/provider";
import { checkTimestamps, ContentSummary, HookAnalysis } from "@/server/analysis/ai/schemas";
import { estimateCostUsd } from "@/server/analysis/config";
import { PermanentError, RetryableError } from "@/server/analysis/errors";
import { parseProbe, parseSceneMetadata } from "@/server/analysis/media/ffmpeg";
import { buildScenes, selectScenesForVision } from "@/server/analysis/media/scenes";
import { OpenAIWhisperProvider } from "@/server/analysis/transcription/openai-whisper";

describe("scene detection parsing and boundaries", () => {
  it("parses ffmpeg metadata=print output", () => {
    const text = "frame:0    pts:50      pts_time:2.0\nlavfi.scene_score=0.912\nframe:1    pts:100     pts_time:4.04\nlavfi.scene_score=0.88\n";
    expect(parseSceneMetadata(text)).toEqual([{ timeSeconds: 2, score: 0.912 }, { timeSeconds: 4.04, score: 0.88 }]);
  });

  it("builds contiguous scenes that cover the whole video", () => {
    const s = buildScenes([{ timeSeconds: 2, score: 0.9 }, { timeSeconds: 4, score: 0.8 }], 6);
    expect(s.map((x) => [x.startMs, x.endMs, x.frameTimeMs])).toEqual([[0, 2000, 1000], [2000, 4000, 3000], [4000, 6000, 5000]]);
    expect(s[0]!.cutScore).toBeNull();
  });

  it("merges cuts closer than the minimum scene length, keeping the strongest", () => {
    const s = buildScenes([{ timeSeconds: 2, score: 0.4 }, { timeSeconds: 2.2, score: 0.95 }], 6, { minSceneSeconds: 0.5 });
    expect(s.map((x) => x.startMs)).toEqual([0, 2200]);
  });

  it("caps scene count by dropping the weakest real cuts", () => {
    const cuts = Array.from({ length: 10 }, (_, i) => ({ timeSeconds: i + 1, score: i / 10 }));
    const s = buildScenes(cuts, 12, { maxScenes: 4 });
    expect(s).toHaveLength(4);
    expect(s.slice(1).map((x) => x.startMs)).toEqual([8000, 9000, 10000]);
  });

  it("returns a single scene when no cuts are detected, and nothing for zero duration", () => {
    expect(buildScenes([], 5)).toHaveLength(1);
    expect(buildScenes([], 0)).toEqual([]);
  });

  it("spreads the vision budget evenly", () => {
    expect(selectScenesForVision(5, 10)).toEqual([0, 1, 2, 3, 4]);
    expect(selectScenesForVision(40, 5)).toEqual([0, 10, 20, 29, 39]);
  });
});

describe("ffprobe parsing", () => {
  it("extracts duration, streams, fps and rotation", () => {
    const m = parseProbe({
      format: { duration: "12.5", format_name: "mov,mp4", size: "1000", bit_rate: "640" },
      streams: [
        { codec_type: "video", codec_name: "h264", width: 1080, height: 1920, avg_frame_rate: "30000/1001", side_data_list: [{ rotation: -90 }] },
        { codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
      ],
    });
    expect(m).toMatchObject({ durationSeconds: 12.5, video: { codec: "h264", width: 1080, height: 1920, fps: 29.97, rotation: -90 }, audio: { codec: "aac", channels: 2 } });
  });
});

describe("transcript alignment and measured editing facts", () => {
  const segs = [
    { startMs: 0, endMs: 1500, text: "One.", speaker: null, confidence: null },
    { startMs: 1800, endMs: 2600, text: "Two.", speaker: null, confidence: null },
  ];
  it("attaches overlapping segments to scenes", () => {
    expect(transcriptForScene({ startMs: 0, endMs: 2000 }, segs)).toBe("One. Two.");
    expect(transcriptForScene({ startMs: 3000, endMs: 4000 }, segs)).toBe("");
  });
  it("computes facts from processing only", () => {
    const facts = computeEditingFacts(buildScenes([{ timeSeconds: 2, score: 1 }], 6), 6, segs);
    expect(facts).toEqual({ sceneCount: 2, averageSceneSeconds: 3, shortestSceneSeconds: 2, longestSceneSeconds: 4, cutsPerMinute: 10, speechCoverage: 0.38, firstCutSeconds: 2 });
    expect(formatTimestamp(65_400)).toBe("1:05");
  });
});

describe("AI response validation", () => {
  it("rejects outputs that do not match the schema", () => {
    expect(HookAnalysis.safeParse({ hook_type: "made_up" }).success).toBe(false);
    expect(ContentSummary.safeParse({ main_topic: "x", intended_audience: null, content_format: "y", communication_objective: "z", key_takeaways: [] }).success).toBe(true);
  });
  it("flags timestamps and scene indices outside the processed media", () => {
    expect(checkTimestamps({ evidence: [{ timestamp_sec: 5 }], estimated_hook_duration_sec: 2 }, 10, 3)).toEqual([]);
    expect(checkTimestamps({ evidence: [{ timestamp_sec: 50 }] }, 10)).toHaveLength(1);
    expect(checkTimestamps({ scene_notes: [{ scene_index: 7 }] }, 10, 3)).toHaveLength(1);
  });
  it("estimates cost only for known models", () => {
    expect(estimateCostUsd("claude-opus-5-5", 1_000_000, 100_000)).toBe(6);
    expect(estimateCostUsd("unknown-model", 1, 1)).toBeNull();
  });
});

describe("Claude provider (stubbed SDK client — not a live call)", () => {
  function stub(result: unknown | (() => never)) {
    const parse = vi.fn(async () => (typeof result === "function" ? (result as () => never)() : result));
    return { client: { beta: { messages: { parse } } } as unknown as Anthropic, parse };
  }
  const req = { purpose: "summary", promptVersion: "summary@1", system: "sys", content: [{ type: "text" as const, text: "ctx" }, { type: "image" as const, mediaType: "image/jpeg" as const, base64: "AAAA" }], schema: ContentSummary };
  const valid = { main_topic: "t", intended_audience: null, content_format: "f", communication_objective: "o", key_takeaways: ["k"] };

  it("sends structured-output config, refusal fallbacks and image blocks; returns validated data with usage and cost", async () => {
    const { client, parse } = stub({ parsed_output: valid, stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 200 }, model: "claude-opus-5-5" });
    const m = new ClaudeAnalysisModel("claude-opus-5-5", { client });
    const res = await m.generate(req);
    expect(res).toMatchObject({ data: valid, servedModel: "claude-opus-5-5", inputTokens: 1000, outputTokens: 200, costUsd: 0.008 });
    const params = (parse.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params).toMatchObject({ model: "claude-opus-5-5", betas: ["server-side-fallback-2026-07-01"], fallbacks: "default", system: "sys" });
    expect((params.output_config as { effort: string }).effort).toBe("medium");
    expect(JSON.stringify(params.messages)).toContain('"type":"image"');
  });

  it("re-validates the parsed output and raises InvalidOutputError", async () => {
    const { client } = stub({ parsed_output: { main_topic: 1 }, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, model: "claude-opus-5-5" });
    await expect(new ClaudeAnalysisModel("claude-opus-5-5", { client }).generate(req)).rejects.toBeInstanceOf(InvalidOutputError);
  });

  it("surfaces refusals and truncation", async () => {
    const refused = stub({ parsed_output: null, stop_reason: "refusal", stop_details: { category: "cyber" }, usage: { input_tokens: 1, output_tokens: 0 }, model: "x" });
    await expect(new ClaudeAnalysisModel("claude-opus-5-5", { client: refused.client }).generate(req)).rejects.toBeInstanceOf(RefusalError);
    const truncated = stub({ parsed_output: null, stop_reason: "max_tokens", usage: { input_tokens: 1, output_tokens: 1 }, model: "x" });
    await expect(new ClaudeAnalysisModel("claude-opus-5-5", { client: truncated.client }).generate(req)).rejects.toBeInstanceOf(InvalidOutputError);
  });

  it("maps SDK errors to retryable vs permanent", async () => {
    const headers = new Headers();
    const rate = stub(() => { throw new Anthropic.RateLimitError(429, {}, "slow down", headers); });
    await expect(new ClaudeAnalysisModel("m", { client: rate.client }).generate(req)).rejects.toBeInstanceOf(RetryableError);
    const auth = stub(() => { throw new Anthropic.AuthenticationError(401, {}, "bad key", headers); });
    await expect(new ClaudeAnalysisModel("m", { client: auth.client }).generate(req)).rejects.toBeInstanceOf(PermanentError);
  });

  it("can disable fallbacks", async () => {
    const { client, parse } = stub({ parsed_output: valid, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, model: "m" });
    await new ClaudeAnalysisModel("m", { client, fallbacks: false }).generate(req);
    expect((parse.mock.calls[0] as unknown[])[0]).not.toHaveProperty("fallbacks");
  });
});

describe("Whisper transcription client (mocked HTTP — not a live call)", () => {
  const audio = path.join(mkdtempSync(path.join(os.tmpdir(), "cos-a-")), "a.mp3");
  writeFileSync(audio, Buffer.alloc(1024));

  it("requests verbose_json segments and preserves timestamps", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ language: "english", duration: 3.2, text: "Hi there", segments: [{ start: 0.24, end: 1.5, text: " Hi", avg_logprob: -0.1 }, { start: 1.5, end: 3.2, text: " there" }] }), { status: 200 }));
    const r = await new OpenAIWhisperProvider("sk-test", fetchImpl as unknown as typeof fetch).transcribe(audio);
    expect(r.segments).toEqual([
      { startMs: 240, endMs: 1500, text: "Hi", speaker: null, confidence: 0.90484 },
      { startMs: 1500, endMs: 3200, text: "there", speaker: null, confidence: null },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    const body = (init as RequestInit).body as FormData;
    expect(body.get("model")).toBe("whisper-1");
    expect(body.get("response_format")).toBe("verbose_json");
    expect(body.getAll("timestamp_granularities[]")).toEqual(["segment"]);
  });

  it("classifies provider errors", async () => {
    const t = (status: number) => new OpenAIWhisperProvider("k", vi.fn().mockResolvedValue(new Response("{}", { status })) as unknown as typeof fetch).transcribe(audio);
    await expect(t(503)).rejects.toBeInstanceOf(RetryableError);
    await expect(t(429)).rejects.toBeInstanceOf(RetryableError);
    await expect(t(400)).rejects.toBeInstanceOf(PermanentError);
  });
});
