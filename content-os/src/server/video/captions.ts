import { sceneStarts, timelineDuration, VIDEO_FORMATS, type CaptionLine, type Timeline, type VideoFormat, type Word } from "./timeline";

/**
 * Captions and on-screen text. Everything burned into a video goes through
 * one generated ASS subtitle file rendered by libass — user text is escaped
 * and never interpolated into an ffmpeg filter string.
 */

// Instagram UI covers parts of the frame. Fractions of width/height.
export const SAFE_ZONES: Record<VideoFormat, { top: number; bottom: number; left: number; right: number }> = {
  vertical: { top: 0.12, bottom: 0.22, left: 0.06, right: 0.12 },
  square: { top: 0.05, bottom: 0.08, left: 0.05, right: 0.05 },
  portrait: { top: 0.06, bottom: 0.1, left: 0.05, right: 0.08 },
};

interface StyleDef {
  size: number;
  bold: boolean;
  primary: string; // &HAABBGGRR
  secondary: string;
  outline: number;
  shadow: number;
  borderStyle: 1 | 3;
  back: string;
}
const WHITE = "&H00FFFFFF";
const BLACK = "&H00000000";
const YELLOW = "&H0000E5FF";

export const TEXT_STYLE_DEFS: Record<string, StyleDef> = {
  bold: { size: 72, bold: true, primary: WHITE, secondary: WHITE, outline: 4, shadow: 0, borderStyle: 1, back: BLACK },
  clean: { size: 60, bold: false, primary: WHITE, secondary: WHITE, outline: 2, shadow: 2, borderStyle: 1, back: "&H80000000" },
  boxed: { size: 60, bold: true, primary: WHITE, secondary: WHITE, outline: 14, shadow: 0, borderStyle: 3, back: "&H66000000" },
  outline: { size: 76, bold: true, primary: WHITE, secondary: WHITE, outline: 6, shadow: 0, borderStyle: 1, back: BLACK },
  minimal: { size: 48, bold: false, primary: WHITE, secondary: WHITE, outline: 1, shadow: 1, borderStyle: 1, back: "&H80000000" },
};
export const CAPTION_STYLE_DEFS: Record<string, StyleDef> = {
  clean: { size: 58, bold: true, primary: WHITE, secondary: WHITE, outline: 3, shadow: 1, borderStyle: 1, back: "&H80000000" },
  bold_box: { size: 62, bold: true, primary: WHITE, secondary: WHITE, outline: 14, shadow: 0, borderStyle: 3, back: "&H66000000" },
  // Karaoke: words turn from Secondary (white) to Primary (yellow) as they are spoken.
  highlight: { size: 64, bold: true, primary: YELLOW, secondary: WHITE, outline: 4, shadow: 0, borderStyle: 1, back: BLACK },
  minimal: { size: 48, bold: false, primary: WHITE, secondary: WHITE, outline: 1, shadow: 1, borderStyle: 1, back: "&H80000000" },
  outline: { size: 66, bold: true, primary: WHITE, secondary: WHITE, outline: 5, shadow: 0, borderStyle: 1, back: BLACK },
};

/** Approximate characters per line for a font size inside the safe area. */
export function maxCharsPerLine(format: VideoFormat, fontSize: number): number {
  const { width } = VIDEO_FORMATS[format];
  const z = SAFE_ZONES[format];
  const usable = width * (1 - z.left - z.right);
  return Math.max(8, Math.floor(usable / (fontSize * 0.56)));
}

export function wrapText(text: string, maxChars: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if ((line + " " + word).length <= maxChars) line += " " + word;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/** Escapes text for an ASS Dialogue line: override tags and braces are neutralised. */
export function assEscape(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, "")
    .replace(/\\/g, "\uFF3C")
    .replace(/\{/g, "\uFF5B")
    .replace(/\}/g, "\uFF5D")
    .replace(/\r?\n/g, "\\N")
    .trim();
}

export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs % 100).padStart(2, "0")}`;
}

export function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

export function toSrt(lines: CaptionLine[]): string {
  return lines
    .filter((l) => l.text.trim())
    .map((l, i) => `${i + 1}\n${srtTime(l.start)} --> ${srtTime(l.end)}\n${l.text.replace(/\r?\n/g, " ").trim()}\n`)
    .join("\n");
}

const CHUNK_CHARS: Record<VideoFormat, number> = { vertical: 32, square: 40, portrait: 36 };
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Captions with ESTIMATED timing from scene durations (no voiceover): each
 * scene's spoken text is chunked and spread over the scene by length.
 */
export function estimateCaptions(t: Timeline): CaptionLine[] {
  const starts = sceneStarts(t);
  const out: CaptionLine[] = [];
  t.scenes.forEach((s, i) => {
    const chunks = chunkWords(s.spoken_text.split(/\s+/).filter(Boolean), CHUNK_CHARS[t.format]);
    if (!chunks.length) return;
    const totalChars = chunks.reduce((n, c) => n + c.length, 0);
    let at = starts[i]!;
    for (const c of chunks) {
      const d = (c.length / totalChars) * s.duration;
      out.push({ start: r3(at), end: r3(Math.min(starts[i]! + s.duration, at + d)), text: c });
      at += d;
    }
  });
  return out;
}

function chunkWords(words: string[], maxChars: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > maxChars) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
    if (/[.!?]$/.test(w)) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Captions timed from MEASURED word timestamps (voiceover transcription).
 * Breaks on length, pauses over 0.6 s and sentence ends.
 */
export function captionsFromWords(words: Word[], offset: number, format: VideoFormat, totalSeconds: number): CaptionLine[] {
  const maxChars = CHUNK_CHARS[format];
  const lines: CaptionLine[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim();
    if (text) lines.push({ start: r3(cur[0]!.start + offset), end: r3(cur[cur.length - 1]!.end + offset), text, words: cur.map((w) => ({ start: r3(w.start + offset), end: r3(w.end + offset), text: w.text.trim() })) });
    cur = [];
  };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    const text = cur.map((x) => x.text.trim()).join(" ");
    if (prev && ((text + " " + w.text.trim()).length > maxChars || w.start - prev.end > 0.6 || /[.!?]$/.test(prev.text.trim()))) flush();
    cur.push(w);
  }
  flush();
  // Minimum readable duration without overlapping the next caption or the end of the video.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const limit = Math.min(lines[i + 1]?.start ?? totalSeconds, totalSeconds);
    if (l.end - l.start < 0.7) l.end = r3(Math.min(limit, l.start + 0.7));
    if (l.end > limit) l.end = r3(limit);
  }
  return lines.filter((l) => l.end > l.start && l.start < totalSeconds);
}

// ---------------------------------------------------------------------------
// ASS generation
// ---------------------------------------------------------------------------
function styleLine(name: string, d: StyleDef, alignment: number, marginL: number, marginR: number, marginV: number) {
  return `Style: ${name},DejaVu Sans,${d.size},${d.primary},${d.secondary},${BLACK},${d.back},${d.bold ? -1 : 0},0,0,0,100,100,0,0,${d.borderStyle},${d.outline},${d.shadow},${alignment},${marginL},${marginR},${marginV},1`;
}

const ALIGN = { top: 8, center: 5, bottom: 2, lower_third: 2 } as const;

function marginsFor(format: VideoFormat, position: keyof typeof ALIGN, layer: "text" | "caption") {
  const { width, height } = VIDEO_FORMATS[format];
  const z = SAFE_ZONES[format];
  const marginL = Math.round(width * z.left);
  const marginR = Math.round(width * z.right);
  let marginV = 0;
  if (position === "top") marginV = Math.round(height * z.top) + 20;
  if (position === "bottom") marginV = Math.round(height * z.bottom) + (layer === "text" ? Math.round(height * 0.08) : 0);
  if (position === "lower_third") marginV = Math.round(height * 0.3);
  return { marginL, marginR, marginV };
}

function karaoke(line: CaptionLine): string {
  // Without measured word timing there is nothing to highlight: show the line in the base colour.
  if (!line.words?.length) return `{\\1c&HFFFFFF&}${assEscape(line.text)}`;
  let at = line.start;
  return line.words
    .map((w) => {
      const lead = Math.max(0, Math.round((w.start - at) * 100));
      const dur = Math.max(1, Math.round((w.end - Math.max(w.start, at)) * 100));
      at = w.end;
      return `${lead ? `{\\k${lead}}` : ""}{\\k${dur}}${assEscape(w.text)}`;
    })
    .join(" ");
}

export interface AssOptions {
  watermark?: string | null;
}

/** Builds the ASS document with on-screen text, burned-in captions and an optional watermark. */
export function buildAss(t: Timeline, opts: AssOptions = {}): string {
  const { width, height } = VIDEO_FORMATS[t.format];
  const styles: string[] = [];
  const events: string[] = [];
  const starts = sceneStarts(t);
  const total = timelineDuration(t);

  const usedText = new Set(t.scenes.filter((s) => s.text?.content.trim()).map((s) => `${s.text!.style}:${s.text!.position}`));
  for (const key of usedText) {
    const [style, position] = key.split(":") as [string, "top" | "center" | "bottom"];
    const m = marginsFor(t.format, position, "text");
    styles.push(styleLine(`T_${style}_${position}`, TEXT_STYLE_DEFS[style] ?? TEXT_STYLE_DEFS.bold!, ALIGN[position], m.marginL, m.marginR, m.marginV));
  }
  t.scenes.forEach((s, i) => {
    if (!s.text?.content.trim()) return;
    const maxChars = maxCharsPerLine(t.format, (TEXT_STYLE_DEFS[s.text.style] ?? TEXT_STYLE_DEFS.bold!).size);
    const text = wrapText(s.text.content, maxChars).map(assEscape).join("\\N");
    events.push(`Dialogue: 1,${assTime(starts[i]!)},${assTime(starts[i]! + s.duration)},T_${s.text.style}_${s.text.position},,0,0,0,,${text}`);
  });

  if (t.captions.enabled && t.captions.burn_in && t.captions.lines.length) {
    const def = CAPTION_STYLE_DEFS[t.captions.style] ?? CAPTION_STYLE_DEFS.clean!;
    const m = marginsFor(t.format, t.captions.position, "caption");
    styles.push(styleLine("Caption", def, ALIGN[t.captions.position], m.marginL, m.marginR, m.marginV));
    for (const l of t.captions.lines) {
      if (!l.text.trim() || l.start >= total) continue;
      const body = t.captions.style === "highlight" ? karaoke(l) : assEscape(l.text);
      events.push(`Dialogue: 2,${assTime(l.start)},${assTime(Math.min(l.end, total))},Caption,,0,0,0,,${body}`);
    }
  }

  if (opts.watermark) {
    styles.push(`Style: Watermark,DejaVu Sans,${Math.round(width / 9)},&H99FFFFFF,&H99FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,8,-20,1,2,0,5,0,0,0,1`);
    events.push(`Dialogue: 0,${assTime(0)},${assTime(total)},Watermark,,0,0,0,,${assEscape(opts.watermark)}`);
  }

  return [
    "[Script Info]",
    "; Generated by Content OS Video Studio",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    ...styles,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    "",
  ].join("\n");
}

/** Text that will not fit its layout (too many wrapped lines). */
export function overflowingText(t: Timeline): { scene: number | null; kind: "text" | "caption"; detail: string }[] {
  const out: { scene: number | null; kind: "text" | "caption"; detail: string }[] = [];
  t.scenes.forEach((s, i) => {
    if (!s.text?.content.trim()) return;
    const lines = wrapText(s.text.content, maxCharsPerLine(t.format, (TEXT_STYLE_DEFS[s.text.style] ?? TEXT_STYLE_DEFS.bold!).size)).length;
    if (lines > 4) out.push({ scene: i + 1, kind: "text", detail: `On-screen text wraps to ${lines} lines (max 4)` });
  });
  if (t.captions.enabled) {
    const max = maxCharsPerLine(t.format, (CAPTION_STYLE_DEFS[t.captions.style] ?? CAPTION_STYLE_DEFS.clean!).size);
    t.captions.lines.forEach((l, i) => {
      const lines = wrapText(l.text, max).length;
      if (lines > 2) out.push({ scene: null, kind: "caption", detail: `Caption ${i + 1} wraps to ${lines} lines (max 2)` });
    });
  }
  return out;
}
