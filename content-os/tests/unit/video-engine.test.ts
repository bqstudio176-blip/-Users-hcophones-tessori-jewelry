import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { classifyUpload, sniffMatchesKind, sniffMedia } from "@/lib/video/media-types";
import { parseEbur128 } from "@/server/analysis/media/ffmpeg";
import { OpenAIWhisperProvider } from "@/server/analysis/transcription/openai-whisper";
import { assEscape, buildAss, captionsFromWords, estimateCaptions, overflowingText, toSrt, wrapText } from "@/server/video/captions";
import { evaluateChecks, renderCredits, voiceGaps, type RenderStats } from "@/server/video/checks";
import { buildRenderPlan, escapeFilterPath, type LocalAsset } from "@/server/video/compose";
import {
  alignScenesToWords,
  buildInitialTimeline,
  mergeScriptUpdate,
  sceneStarts,
  scriptDeviation,
  Timeline,
  timelineDuration,
  validateTimeline,
  type AssetInfo,
} from "@/server/video/timeline";

const A = "11111111-1111-4111-8111-111111111111";
const IMG = "22222222-2222-4222-8222-222222222222";
const VO = "33333333-3333-4333-8333-333333333333";
const MUS = "44444444-4444-4444-8444-444444444444";

const script = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", position: 1, scene_title: "Hook", estimated_duration_seconds: "3.00", spoken_text: "Stop scrolling for a second", on_screen_text: "Wait!" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", position: 2, scene_title: "Point", estimated_duration_seconds: 4, spoken_text: "Here is the one idea that really matters today", on_screen_text: "" },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", position: 3, scene_title: "CTA", estimated_duration_seconds: 2, spoken_text: "Follow for part two", on_screen_text: "" },
];

const ready = (id: string, kind: AssetInfo["kind"], extra: Partial<AssetInfo> = {}): AssetInfo => ({ id, kind, status: "ready", duration_seconds: 10, has_audio: true, ...extra });
const assets = new Map([[A, ready(A, "video")], [IMG, ready(IMG, "image", { duration_seconds: null, has_audio: false })], [VO, ready(VO, "audio")], [MUS, ready(MUS, "audio")]]);

function fullTimeline(): Timeline {
  const t = buildInitialTimeline(script, "vertical");
  t.scenes[0]!.visual = { asset_id: A, kind: "video", trim_start: 1, fit: "fill", focal_x: 0.5, focal_y: 0.5, ken_burns: false, volume: 0.3 };
  t.scenes[0]!.transition = "crossfade";
  t.scenes[1]!.visual = { asset_id: IMG, kind: "image", trim_start: 0, fit: "fit_blur", focal_x: 0.5, focal_y: 0.5, ken_burns: true, volume: 0 };
  t.voiceover = { asset_id: VO, take_id: null, volume: 1, offset: 0 };
  t.music = { asset_id: MUS, start: 2, volume: 0.4, fade_in: 1, fade_out: 1, duck: true };
  return t;
}

describe("timeline", () => {
  it("is built from the script's scenes with on-screen text and estimated durations", () => {
    const t = buildInitialTimeline(script, "vertical");
    expect(Timeline.safeParse(t).success).toBe(true);
    expect(t.scenes.map((s) => s.duration)).toEqual([3, 4, 2]);
    expect(t.scenes[0]!.text?.content).toBe("Wait!");
    expect(timelineDuration(t)).toBe(9);
    expect(sceneStarts(t)).toEqual([0, 3, 7]);
  });

  it("scales over-long scripts down to the 3-minute limit", () => {
    const long = Array.from({ length: 5 }, (_, i) => ({ ...script[0]!, id: `aaaaaaaa-0000-4000-8000-00000000001${i}`, position: i + 1, estimated_duration_seconds: 60 }));
    expect(timelineDuration(buildInitialTimeline(long, "vertical"))).toBeLessThanOrEqual(180);
  });

  it("validates media kinds, readiness, trims, voice exclusivity and caption order", () => {
    expect(validateTimeline(fullTimeline(), assets)).toEqual([]);
    const t = fullTimeline();
    t.scenes[0]!.visual!.trim_start = 12;
    t.scenes[1]!.visual = { ...t.scenes[1]!.visual!, asset_id: VO };
    t.scenes[2]!.voice = { asset_id: VO, take_id: null, volume: 1 };
    t.captions.lines = [{ start: 2, end: 3, text: "b" }, { start: 1, end: 1.5, text: "a" }];
    const p = validateTimeline(t, new Map([...assets, [MUS, { ...assets.get(MUS)!, status: "processing" }]]));
    expect(p.join("\n")).toMatch(/beyond the clip length/);
    expect(p.join("\n")).toMatch(/expected image, got audio/);
    expect(p.join("\n")).toMatch(/either one voiceover/);
    expect(p.join("\n")).toMatch(/Music: media is still processing/);
    expect(p.join("\n")).toMatch(/overlaps the previous/);
  });

  it("merges a newer script without losing media or the user's own text", () => {
    const t = fullTimeline();
    t.scenes[1]!.text = { content: "My own title", style: "clean", position: "center" };
    const updated = [
      { ...script[0]!, spoken_text: "Stop scrolling now", on_screen_text: "Hey!" },
      { ...script[1]!, on_screen_text: "Script title" },
      { id: "aaaaaaaa-0000-4000-8000-000000000009", position: 3, scene_title: "New", estimated_duration_seconds: 2, spoken_text: "Brand new", on_screen_text: "" },
    ];
    const { timeline, diff } = mergeScriptUpdate(t, script, updated);
    expect(diff).toEqual({ added: ["New"], removed: ["CTA"], changed: ["Hook"] });
    expect(timeline.scenes[0]!.visual?.asset_id).toBe(A);
    expect(timeline.scenes[0]!.text?.content).toBe("Hey!"); // untouched text follows the script
    expect(timeline.scenes[1]!.text?.content).toBe("My own title"); // user edit kept
  });

  it("aligns scene durations to measured voiceover words", () => {
    const t = buildInitialTimeline(script, "vertical");
    const all = script.flatMap((s) => s.spoken_text.split(" "));
    const words = all.map((w, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, text: w }));
    const aligned = alignScenesToWords(t, words);
    // 5 + 9 + 4 words at 0.5 s each.
    expect(aligned.scenes.map((s) => s.duration)).toEqual([2.45, 4.5, 2.35]);
    expect(timelineDuration(aligned)).toBeCloseTo(words[words.length - 1]!.end + 0.4, 1);
  });

  it("measures how a take deviates from the script", () => {
    const d = scriptDeviation("Here is the one idea that matters", "Here is one big idea that matters");
    expect(d.similarity).toBeGreaterThan(0.8);
    expect(d.missing).toEqual(["the"]);
    expect(d.extra).toEqual(["big"]);
  });
});

describe("captions and ASS", () => {
  it("neutralises ASS override tags, braces and control characters", () => {
    const evil = "Hi {\\pos(0,0)\\fs300} there\\N\u0007";
    const out = assEscape(evil);
    expect(out).not.toMatch(/[{}\\]N?/);
    expect(out).not.toContain("\u0007");
    const ass = buildAss({ ...fullTimeline(), scenes: fullTimeline().scenes.map((s, i) => (i === 0 ? { ...s, text: { content: evil, style: "bold", position: "top" } } : s)) });
    const dialogue = ass.split("\n").filter((l) => l.startsWith("Dialogue:"));
    expect(dialogue.join("\n")).not.toContain("\\pos");
    expect(dialogue.join("\n")).not.toContain("\\fs300");
  });

  it("estimates captions within each scene and labels nothing as measured", () => {
    const t = buildInitialTimeline(script, "vertical");
    const lines = estimateCaptions(t);
    expect(lines[0]!.start).toBe(0);
    expect(lines.every((l) => !l.words)).toBe(true);
    const starts = sceneStarts(t);
    expect(lines.filter((l) => l.start >= starts[1]! && l.start < starts[2]!).every((l) => l.end <= starts[2]! + 0.001)).toBe(true);
  });

  it("times captions from words, breaking on pauses and sentence ends", () => {
    const words = [
      { start: 0, end: 0.3, text: "One" }, { start: 0.35, end: 0.6, text: "idea." }, { start: 0.7, end: 1, text: "Then" },
      { start: 2.5, end: 2.8, text: "after" }, { start: 2.85, end: 3.1, text: "pause" },
    ];
    const lines = captionsFromWords(words, 1, "vertical", 10);
    expect(lines.map((l) => l.text)).toEqual(["One idea.", "Then", "after pause"]);
    expect(lines[0]!.start).toBe(1);
    expect(lines[1]!.end - lines[1]!.start).toBeGreaterThanOrEqual(0.7);
    const ass = buildAss({ ...fullTimeline(), captions: { enabled: true, burn_in: true, style: "highlight", position: "bottom", source: "voiceover", lines } });
    expect(ass).toMatch(/\{\\k\d+\}One/);
  });

  it("exports SRT and wraps text to the safe area", () => {
    expect(toSrt([{ start: 1.5, end: 3.25, text: "Hello" }])).toBe("1\n00:00:01,500 --> 00:00:03,250\nHello\n");
    expect(wrapText("one two three four", 9)).toEqual(["one two", "three", "four"]);
    const t = buildInitialTimeline(script, "vertical");
    t.scenes[0]!.text = { content: "word ".repeat(80), style: "outline", position: "top" };
    expect(overflowingText(t)[0]?.detail).toMatch(/wraps to \d+ lines/);
  });
});

describe("render plan", () => {
  const local = new Map<string, LocalAsset>([
    [A, { file: "/tmp/w/clip.mp4", kind: "video", hasAudio: true, durationSeconds: 10 }],
    [IMG, { file: "/tmp/w/img.jpg", kind: "image", hasAudio: false, durationSeconds: null }],
    [VO, { file: "/tmp/w/vo.m4a", kind: "audio", hasAudio: true, durationSeconds: 10 }],
    [MUS, { file: "/tmp/w/mus.mp3", kind: "audio", hasAudio: true, durationSeconds: 30 }],
  ]);

  it("builds an argument array with crossfades, ducking, loudness and the ASS overlay", () => {
    const plan = buildRenderPlan({ timeline: fullTimeline(), assets: local, kind: "final", assFile: "/tmp/w/overlay.ass", output: "/tmp/w/out.mp4" });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect([plan.width, plan.height, plan.totalSeconds]).toEqual([1080, 1920, 9]);
    expect(graph).toContain("xfade=transition=fade:duration=0.5:offset=3");
    expect(graph).toContain("sidechaincompress");
    expect(graph).toContain("loudnorm=I=-14");
    expect(graph).toContain("zoompan");
    expect(graph).toContain("ass=filename='/tmp/w/overlay.ass'");
    expect(plan.args).toContain("/tmp/w/clip.mp4"); // file paths are separate argv entries
    expect(graph).not.toContain("/tmp/w/clip.mp4");
    expect(plan.args.slice(-2)).toEqual(["9", "/tmp/w/out.mp4"]);
  });

  it("renders drafts at half resolution without loudness normalisation and fills missing media with black", () => {
    const t = buildInitialTimeline(script, "square");
    const plan = buildRenderPlan({ timeline: t, assets: new Map(), kind: "draft", assFile: null, output: "/tmp/o.mp4" });
    const graph = plan.args[plan.args.indexOf("-filter_complex") + 1]!;
    expect([plan.width, plan.height]).toEqual([540, 540]);
    expect(graph).not.toContain("loudnorm");
    expect(plan.args.filter((a) => a.startsWith("color=c=black"))).toHaveLength(3);
  });

  it("never puts user text in the filter graph and escapes filter paths", () => {
    const t = fullTimeline();
    t.scenes[0]!.title = "'; rm -rf / #";
    t.scenes[0]!.text = { content: "[0:v] drawtext=text=pwn", style: "bold", position: "top" };
    const graph = buildRenderPlan({ timeline: t, assets: local, kind: "final", assFile: "/tmp/w/o.ass", output: "/tmp/o.mp4" }).args.join(" ");
    expect(graph).not.toContain("rm -rf");
    expect(graph).not.toContain("drawtext");
    expect(escapeFilterPath("/tmp/a:b,c'd[e]")).toBe("/tmp/a\\:b\\,c\\'d\\[e\\]");
  });
});

describe("checks, pricing and media types", () => {
  const stats: RenderStats = { durationSeconds: 9, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac", fps: 30, bitRate: 6_000_000, integratedLufs: -14.2, truePeakDb: -1.6 };

  it("passes a clean final render and fails drafts or missing media", () => {
    const t = fullTimeline();
    t.scenes[2]!.visual = t.scenes[0]!.visual;
    t.captions.lines = [{ start: 0, end: 1, text: "hi" }];
    const ok = evaluateChecks({ timeline: t, kind: "final", stats, targetSeconds: 9, scriptChanged: false, gaps: [] });
    expect(ok.overall).toBe("pass");
    const draft = evaluateChecks({ timeline: buildInitialTimeline(script, "vertical"), kind: "draft", stats: { ...stats, width: 540, height: 960 }, targetSeconds: 30, scriptChanged: true, gaps: [{ from: 1, to: 4 }] });
    expect(draft.overall).toBe("fail");
    const ids = Object.fromEntries(draft.items.map((i) => [i.id, i.status]));
    expect(ids).toMatchObject({ render_kind: "fail", media: "fail", duration_target: "warn", script_sync: "warn", captions: "warn" });
    const loud = evaluateChecks({ timeline: t, kind: "final", stats: { ...stats, integratedLufs: -20, truePeakDb: 0.5, width: 720 }, targetSeconds: null, scriptChanged: false, gaps: [] });
    expect(Object.fromEntries(loud.items.map((i) => [i.id, i.status]))).toMatchObject({ loudness: "warn", true_peak: "warn", resolution: "fail" });
  });

  it("finds silences over 2 s in a voiceover", () => {
    expect(voiceGaps([{ start: 0, end: 1 }, { start: 1.5, end: 2 }, { start: 4.5, end: 5 }], 1)).toEqual([{ from: 3, to: 5.5 }]);
  });

  it("prices final renders at 3 credits up to 60 s plus 1 per extra 30 s; drafts are free", () => {
    expect([renderCredits("final", 9), renderCredits("final", 60), renderCredits("final", 61), renderCredits("final", 90.5), renderCredits("final", 180), renderCredits("draft", 180)]).toEqual([3, 3, 4, 5, 7, 0]);
  });

  it("classifies uploads and checks magic bytes against the declared kind", () => {
    expect(classifyUpload({ name: "take.webm", type: "audio/webm;codecs=opus", size: 10 })).toEqual({ ok: true, mime: "audio/webm", kind: "audio" });
    expect(classifyUpload({ name: "x.exe", type: "application/octet-stream", size: 10 }).ok).toBe(false);
    expect(classifyUpload({ name: "big.mp4", type: "video/mp4", size: 1024 ** 3 + 1 }).ok).toBe(false);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffMedia(png)).toEqual({ kind: "image", format: "png" });
    expect(sniffMatchesKind(png, "video")).toBe(false);
    expect(sniffMatchesKind(new TextEncoder().encode("#!/bin/sh\necho hi"), "audio")).toBe(false);
    expect(sniffMatchesKind(new TextEncoder().encode("\0\0\0\x18ftypM4A "), "audio")).toBe(true);
  });

  it("parses ebur128 loudness summaries", () => {
    const stderr = "[Parsed_ebur128_0] Summary:\n  Integrated loudness:\n    I:         -14.3 LUFS\n  True peak:\n    Peak:       -1.8 dBFS\n";
    expect(parseEbur128(stderr)).toEqual({ integratedLufs: -14.3, truePeakDb: -1.8 });
    expect(parseEbur128("I: -inf LUFS Peak: -inf dBFS")).toEqual({ integratedLufs: -120, truePeakDb: -120 });
  });

  it("requests word timestamps from Whisper and parses them", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "cos-w-"));
    const audio = path.join(dir, "a.mp3");
    writeFileSync(audio, "fake");
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ text: "Hi there", segments: [], words: [{ word: "Hi", start: 0.1, end: 0.4 }, { word: " there", start: 0.5, end: 0.9 }] }), { status: 200 }));
    const r = await new OpenAIWhisperProvider("k", fetchImpl as unknown as typeof fetch).transcribe(audio, { wordTimestamps: true });
    expect(r.words).toEqual([{ startMs: 100, endMs: 400, text: "Hi" }, { startMs: 500, endMs: 900, text: "there" }]);
    const form = fetchImpl.mock.calls[0]![1].body as FormData;
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
  });
});
