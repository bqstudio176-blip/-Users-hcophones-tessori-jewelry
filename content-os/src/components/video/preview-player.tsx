"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CAPTION_STYLE_DEFS, SAFE_ZONES, TEXT_STYLE_DEFS } from "@/server/video/captions";
import { sceneStarts, timelineDuration, VIDEO_FORMATS, type Timeline } from "@/server/video/timeline";
import type { EditorAsset } from "./types";

const fmt = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;

/** Keeps a media element near a target time; avoids constant seeking. */
function sync(el: HTMLMediaElement | null, target: number | null, playing: boolean, volume: number) {
  if (!el) return;
  if (target === null || target < 0) {
    if (!el.paused) el.pause();
    return;
  }
  el.volume = Math.max(0, Math.min(1, volume));
  el.muted = volume === 0;
  const dur = Number.isFinite(el.duration) ? el.duration : null;
  if (dur !== null && target >= dur) {
    if (!el.paused) el.pause();
    return;
  }
  if (Math.abs(el.currentTime - target) > 0.3) {
    try {
      el.currentTime = target;
    } catch {
      /* not seekable yet */
    }
  }
  if (playing && el.paused) void el.play().catch(() => undefined);
  if (!playing && !el.paused) el.pause();
}

/**
 * Approximate live preview from low-resolution proxies, with HTML overlays
 * for text and captions. The final render (ffmpeg + libass) may differ
 * slightly in fonts, blur and timing; the UI says so.
 */
export function PreviewPlayer({ timeline, assets, className }: { timeline: Timeline; assets: Map<string, EditorAsset>; className?: string }) {
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [guides, setGuides] = useState(false);
  const [width, setWidth] = useState(270);
  const boxRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const voiceRef = useRef<HTMLAudioElement>(null);
  const musicRef = useRef<HTMLAudioElement>(null);
  const total = timelineDuration(timeline);
  const starts = useMemo(() => sceneStarts(timeline), [timeline]);
  const { width: W, height: H } = VIDEO_FORMATS[timeline.format];
  const zone = SAFE_ZONES[timeline.format];
  const scale = width / W;

  let idx = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i]! <= t) idx = i;
  const scene = timeline.scenes[idx]!;
  const local = t - starts[idx]!;
  const visual = scene.visual ? assets.get(scene.visual.asset_id) : undefined;

  useEffect(() => {
    if (!boxRef.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(boxRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((prev) => {
        const n = prev + dt;
        if (n >= total) {
          setPlaying(false);
          return total;
        }
        return n;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, total]);

  // Voice: one track for the whole video, or the current scene's take.
  const voiceAsset = timeline.voiceover ? assets.get(timeline.voiceover.asset_id) : scene.voice ? assets.get(scene.voice.asset_id) : undefined;
  const voiceTarget = timeline.voiceover ? t - timeline.voiceover.offset : scene.voice ? local : null;
  const voiceVolume = timeline.voiceover?.volume ?? scene.voice?.volume ?? 0;
  const musicAsset = timeline.music ? assets.get(timeline.music.asset_id) : undefined;
  const ducked = timeline.music?.duck && voiceAsset && voiceTarget !== null && voiceTarget >= 0;

  useEffect(() => {
    sync(scene.visual?.kind === "video" ? videoRef.current : null, scene.visual ? scene.visual.trim_start + local : null, playing, scene.visual?.volume ?? 0);
    sync(voiceAsset ? voiceRef.current : null, voiceTarget, playing, voiceVolume);
    if (timeline.music && musicRef.current) {
      const d = Number.isFinite(musicRef.current.duration) ? musicRef.current.duration : null;
      const target = timeline.music.start + t;
      sync(musicRef.current, d ? target % d : target, playing, timeline.music.volume * (ducked ? 0.35 : 1));
    }
  });

  useEffect(() => {
    if (!playing) [videoRef, voiceRef, musicRef].forEach((r) => r.current?.pause());
  }, [playing]);

  const caption = timeline.captions.enabled ? timeline.captions.lines.find((l) => t >= l.start && t < l.end) : undefined;
  const textDef = scene.text ? (TEXT_STYLE_DEFS[scene.text.style] ?? TEXT_STYLE_DEFS.bold!) : null;
  const capDef = CAPTION_STYLE_DEFS[timeline.captions.style] ?? CAPTION_STYLE_DEFS.clean!;
  const pos = (p: string, layer: "text" | "caption"): React.CSSProperties => {
    const base: React.CSSProperties = { position: "absolute", left: `${zone.left * 100}%`, right: `${zone.right * 100}%`, textAlign: "center" };
    if (p === "top") return { ...base, top: `${zone.top * 100 + 1}%` };
    if (p === "center") return { ...base, top: "50%", transform: "translateY(-50%)" };
    if (p === "lower_third") return { ...base, bottom: "30%" };
    return { ...base, bottom: `${(zone.bottom + (layer === "text" ? 0.08 : 0)) * 100}%` };
  };
  const textCss = (d: { size: number; bold: boolean; borderStyle: number; outline: number }, color = "#fff"): React.CSSProperties => ({
    fontFamily: "'DejaVu Sans', system-ui, sans-serif",
    fontSize: d.size * scale,
    fontWeight: d.bold ? 700 : 400,
    color,
    lineHeight: 1.15,
    textShadow: d.borderStyle === 1 ? `0 0 ${Math.max(1, d.outline * scale)}px #000, 0 0 ${Math.max(1, d.outline * scale)}px #000` : undefined,
    background: d.borderStyle === 3 ? "rgba(0,0,0,0.6)" : undefined,
    padding: d.borderStyle === 3 ? `${4 * scale}px ${10 * scale}px` : undefined,
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
  });
  const progress = scene.duration ? Math.min(1, local / scene.duration) : 0;
  const objectPosition = scene.visual ? `${scene.visual.focal_x * 100}% ${scene.visual.focal_y * 100}%` : undefined;

  return (
    <div className={className}>
      <div ref={boxRef} className="relative mx-auto w-full overflow-hidden rounded-lg bg-black" style={{ aspectRatio: `${W} / ${H}` }}>
        {visual && scene.visual?.fit === "fit_blur" && (visual.thumbUrl || visual.proxyUrl) && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={(scene.visual.kind === "image" ? visual.proxyUrl : visual.thumbUrl) ?? ""} alt="" aria-hidden className="absolute inset-0 h-full w-full scale-110 object-cover blur-xl" />
        )}
        {visual && scene.visual?.kind === "video" && visual.proxyUrl && (
          <video key={`${idx}-${visual.id}`} ref={videoRef} src={visual.proxyUrl} playsInline preload="auto" className="absolute inset-0 h-full w-full" style={{ objectFit: scene.visual.fit === "fill" ? "cover" : "contain", objectPosition }} />
        )}
        {visual && scene.visual?.kind === "image" && visual.proxyUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={visual.proxyUrl} alt="" className="absolute inset-0 h-full w-full" style={{ objectFit: scene.visual.fit === "fill" ? "cover" : "contain", objectPosition, transform: scene.visual.ken_burns ? `scale(${1 + 0.12 * progress})` : undefined }} />
        )}
        {!scene.visual && <div className="absolute inset-0 grid place-items-center text-xs text-white/60">No media — renders black</div>}
        {scene.text?.content.trim() && textDef && <div style={pos(scene.text.position, "text")}><span style={textCss(textDef)}>{scene.text.content}</span></div>}
        {caption && <div style={pos(timeline.captions.position, "caption")}><span style={textCss(capDef, timeline.captions.style === "highlight" && caption.words?.length ? "#ffe500" : "#fff")}>{caption.text}</span></div>}
        {guides && (
          <>
            <div className="absolute inset-x-0 top-0 bg-danger/30" style={{ height: `${zone.top * 100}%` }} />
            <div className="absolute inset-x-0 bottom-0 bg-danger/30" style={{ height: `${zone.bottom * 100}%` }} />
            <div className="absolute inset-y-0 left-0 bg-danger/20" style={{ width: `${zone.left * 100}%` }} />
            <div className="absolute inset-y-0 right-0 bg-danger/20" style={{ width: `${zone.right * 100}%` }} />
          </>
        )}
        <span className="absolute left-2 top-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white/80">Scene {idx + 1}</span>
      </div>
      {voiceAsset?.proxyUrl && <audio key={voiceAsset.id + (timeline.voiceover ? "full" : idx)} ref={voiceRef} src={voiceAsset.proxyUrl} preload="auto" />}
      {musicAsset?.proxyUrl && <audio key={musicAsset.id} ref={musicRef} src={musicAsset.proxyUrl} preload="auto" />}
      <div className="mt-2 flex items-center gap-2">
        <button type="button" onClick={() => (t >= total ? (setT(0), setPlaying(true)) : setPlaying((p) => !p))} className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg" aria-label={playing ? "Pause preview" : "Play preview"}>
          {playing ? "Pause" : "Play"}
        </button>
        <input type="range" min={0} max={total} step={0.05} value={t} onChange={(e) => setT(Number(e.target.value))} aria-label="Preview position" className="flex-1 accent-[rgb(var(--color-accent))]" />
        <span className="w-24 text-right text-xs tabular-nums text-fg-muted">{fmt(t)} / {fmt(total)}</span>
      </div>
      <div className="mt-1 flex items-center justify-between">
        <p className="text-[11px] text-fg-subtle">Preview — approximate. The final render may differ slightly.</p>
        <label className="flex items-center gap-1 text-[11px] text-fg-muted"><input type="checkbox" checked={guides} onChange={(e) => setGuides(e.target.checked)} className="accent-[rgb(var(--color-accent))]" />Safe zones</label>
      </div>
    </div>
  );
}
