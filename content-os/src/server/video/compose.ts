import { sceneStarts, timelineDuration, VIDEO_FORMATS, VIDEO_LIMITS, type Timeline } from "./timeline";

/**
 * Pure builder: validated timeline + local asset files → ffmpeg argument
 * array. Every number comes from the zod-validated timeline (bounded and
 * typed) and every file path is passed as its own argv entry. User text never
 * reaches the filter graph: it lives in the ASS file (see captions.ts).
 */
export interface LocalAsset {
  file: string;
  kind: "video" | "image" | "audio";
  hasAudio: boolean;
  durationSeconds: number | null;
}

export interface RenderPlan {
  args: string[];
  totalSeconds: number;
  width: number;
  height: number;
}

export const RENDER_PRESETS = {
  draft: { scale: 0.5, preset: "veryfast", crf: 30, audioBitrate: "96k", loudnorm: false },
  final: { scale: 1, preset: "medium", crf: 20, audioBitrate: "192k", loudnorm: true },
} as const;

const f = (n: number) => (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "") || "0";
const ms = (n: number) => String(Math.max(0, Math.round(n * 1000)));
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/** Escapes a path for use inside a filter-graph option value. Paths are worker-generated temp files. */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/'/g, "\\'").replace(/:/g, "\\:").replace(/,/g, "\\,").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function buildRenderPlan(opts: {
  timeline: Timeline;
  assets: Map<string, LocalAsset>;
  kind: "draft" | "final";
  assFile: string | null;
  fontsDir?: string | null;
  output: string;
}): RenderPlan {
  const { timeline: t, assets, kind } = opts;
  const preset = RENDER_PRESETS[kind];
  const W = even(VIDEO_FORMATS[t.format].width * preset.scale);
  const H = even(VIDEO_FORMATS[t.format].height * preset.scale);
  const T = timelineDuration(t);
  const X = VIDEO_LIMITS.crossfadeSeconds;
  const fps = VIDEO_LIMITS.fps;
  const starts = sceneStarts(t);
  const n = t.scenes.length;

  const inputs: string[] = [];
  let inputCount = 0;
  const addInput = (args: string[]) => {
    inputs.push(...args);
    return inputCount++;
  };
  const filters: string[] = [];
  const asset = (id: string) => {
    const a = assets.get(id);
    if (!a) throw new Error(`Asset ${id} was not prepared for rendering`);
    return a;
  };
  const audioFmt = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo";

  // 0: silent base track — fixes the output length and guarantees an audio stream.
  const silence = addInput(["-f", "lavfi", "-t", f(T), "-i", "anullsrc=r=48000:cl=stereo"]);
  const audioLabels: string[] = [`[${silence}:a]`];
  const voiceLabels: string[] = [];

  // ---- Video segments -------------------------------------------------------
  t.scenes.forEach((s, i) => {
    const xfOut = s.transition === "crossfade" && i < n - 1;
    const L = s.duration + (xfOut ? X : 0);
    let idx: number;
    let chain: string;
    const fill = (fx: number, fy: number) => `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}:(iw-ow)*${f(fx)}:(ih-oh)*${f(fy)}`;
    if (!s.visual) {
      idx = addInput(["-f", "lavfi", "-t", f(L), "-i", `color=c=black:s=${W}x${H}:r=${fps}`]);
      chain = `[${idx}:v]null`;
    } else {
      const a = asset(s.visual.asset_id);
      if (s.visual.kind === "image") {
        idx = addInput(["-loop", "1", "-framerate", String(fps), "-t", f(L), "-i", a.file]);
      } else {
        idx = addInput(["-ss", f(s.visual.trim_start), "-t", f(L + 0.25), "-i", a.file]);
        if (s.visual.volume > 0 && a.hasAudio) {
          filters.push(`[${idx}:a]atrim=0:${f(s.duration)},asetpts=PTS-STARTPTS,${audioFmt},volume=${f(s.visual.volume)},adelay=${ms(starts[i]!)}:all=1[ca${i}]`);
          audioLabels.push(`[ca${i}]`);
        }
      }
      if (s.visual.fit === "fit_blur") {
        chain =
          `[${idx}:v]split=2[bg${i}][fg${i}];` +
          `[bg${i}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bgb${i}];` +
          `[fg${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease[fgs${i}];` +
          `[bgb${i}][fgs${i}]overlay=(main_w-overlay_w)/2:(main_h-overlay_h)/2`;
      } else {
        chain = `[${idx}:v]${fill(s.visual.focal_x, s.visual.focal_y)}`;
      }
      if (s.visual.kind === "image" && s.visual.ken_burns) {
        const frames = Math.max(1, Math.round(L * fps));
        chain += `,scale=${W * 2}:${H * 2},zoompan=z='1+0.12*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${fps}`;
      }
    }
    filters.push(`${chain},setsar=1,fps=${fps},format=yuv420p,tpad=stop_mode=clone:stop_duration=${f(L)},trim=duration=${f(L)},setpts=PTS-STARTPTS[v${i}]`);

    if (s.voice) {
      const a = asset(s.voice.asset_id);
      const vi = addInput(["-i", a.file]);
      filters.push(`[${vi}:a]atrim=0:${f(s.duration)},asetpts=PTS-STARTPTS,${audioFmt},volume=${f(s.voice.volume)},adelay=${ms(starts[i]!)}:all=1[vo${i}]`);
      voiceLabels.push(`[vo${i}]`);
    }
  });

  // Join segments: crossfade where requested, hard cut otherwise.
  let acc = "[v0]";
  for (let i = 1; i < n; i++) {
    const out = `[x${i}]`;
    if (t.scenes[i - 1]!.transition === "crossfade") filters.push(`${acc}[v${i}]xfade=transition=fade:duration=${f(X)}:offset=${f(starts[i]!)}${out}`);
    else filters.push(`${acc}[v${i}]concat=n=2:v=1:a=0${out}`);
    acc = out;
  }
  if (opts.assFile) {
    const fontsDir = opts.fontsDir ? `:fontsdir='${escapeFilterPath(opts.fontsDir)}'` : "";
    filters.push(`${acc}ass=filename='${escapeFilterPath(opts.assFile)}'${fontsDir}[vout]`);
  } else {
    filters.push(`${acc}null[vout]`);
  }

  // ---- Audio ------------------------------------------------------------------
  if (t.voiceover) {
    const a = asset(t.voiceover.asset_id);
    const vi = addInput(["-i", a.file]);
    filters.push(`[${vi}:a]atrim=0:${f(Math.max(0.1, T - t.voiceover.offset))},asetpts=PTS-STARTPTS,${audioFmt},volume=${f(t.voiceover.volume)},adelay=${ms(t.voiceover.offset)}:all=1[vofull]`);
    voiceLabels.push("[vofull]");
  }
  let voiceKey: string | null = null;
  if (voiceLabels.length) {
    const bus = voiceLabels.length === 1 ? voiceLabels[0]! : "[voicebus]";
    if (voiceLabels.length > 1) filters.push(`${voiceLabels.join("")}amix=inputs=${voiceLabels.length}:duration=longest:normalize=0[voicebus]`);
    if (t.music?.duck) {
      filters.push(`${bus}asplit=2[voicemix][voicekey]`);
      audioLabels.push("[voicemix]");
      voiceKey = "[voicekey]";
    } else audioLabels.push(bus);
  }
  if (t.music) {
    const a = asset(t.music.asset_id);
    const mi = addInput(["-stream_loop", "-1", "-ss", f(t.music.start), "-i", a.file]);
    const fadeOut = Math.min(t.music.fade_out, T);
    const fades = [t.music.fade_in > 0 ? `afade=t=in:st=0:d=${f(Math.min(t.music.fade_in, T))}` : null, fadeOut > 0 ? `afade=t=out:st=${f(Math.max(0, T - fadeOut))}:d=${f(fadeOut)}` : null].filter(Boolean).join(",");
    filters.push(`[${mi}:a]atrim=0:${f(T)},asetpts=PTS-STARTPTS,${audioFmt},volume=${f(t.music.volume)}${fades ? `,${fades}` : ""}[mus]`);
    if (voiceKey) {
      filters.push(`[mus]${voiceKey}sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[musd]`);
      audioLabels.push("[musd]");
    } else audioLabels.push("[mus]");
  }
  const post = [preset.loudnorm ? "loudnorm=I=-14:TP=-1.5:LRA=11" : null, "aresample=48000", `atrim=0:${f(T)}`].filter(Boolean).join(",");
  filters.push(`${audioLabels.join("")}amix=inputs=${audioLabels.length}:duration=first:normalize=0,${post}[aout]`);

  const args = [
    "-nostdin", "-y", "-v", "error",
    ...inputs,
    "-filter_complex", filters.join(";"),
    "-map", "[vout]", "-map", "[aout]",
    "-c:v", "libx264", "-preset", preset.preset, "-crf", String(preset.crf), "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-r", String(fps), "-g", String(fps * 2),
    "-c:a", "aac", "-b:a", preset.audioBitrate, "-ar", "48000", "-ac", "2",
    "-movflags", "+faststart",
    "-t", f(T),
    opts.output,
  ];
  return { args, totalSeconds: T, width: W, height: H };
}
