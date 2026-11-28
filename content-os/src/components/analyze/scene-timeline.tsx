"use client";

import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";

export interface TimelineScene {
  idx: number;
  start_ms: number;
  end_ms: number;
  frameUrl: string | null;
  description: string | null;
  framing: string | null;
  textOverlays: string[];
  transcript: string | null;
  purpose: string | null;
  editingNotes: string | null;
  visualAnalyzed: boolean;
  score: number | null;
}

const ts = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

/** Video preview + scene timeline. Clicking a scene seeks the video to its start. */
export function SceneTimeline({ videoUrl, poster, durationMs, scenes, segments }: { videoUrl: string | null; poster: string | null; durationMs: number; scenes: TimelineScene[]; segments: { start_ms: number; end_ms: number; text: string }[] }) {
  const video = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(0);
  const [now, setNow] = useState(0);

  const seek = (ms: number, idx?: number) => {
    if (idx !== undefined) setActive(idx);
    if (video.current) {
      video.current.currentTime = ms / 1000;
      void video.current.play().catch(() => undefined);
    }
  };
  const onTime = () => {
    const t = (video.current?.currentTime ?? 0) * 1000;
    setNow(t);
    const i = scenes.findIndex((s) => t >= s.start_ms && t < s.end_ms);
    if (i >= 0 && i !== active) setActive(i);
  };
  const current = scenes[active];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,22rem)_1fr]">
        <div className="overflow-hidden rounded-lg border border-line bg-black">
          {videoUrl ? (
            <video ref={video} src={videoUrl} poster={poster ?? undefined} controls playsInline preload="metadata" onTimeUpdate={onTime} className="mx-auto max-h-[28rem] w-full" />
          ) : (
            <div className="grid aspect-[9/16] max-h-[28rem] place-items-center text-sm text-fg-subtle">Video preview unavailable</div>
          )}
        </div>
        {current && (
          <section aria-label={`Scene ${current.idx + 1} details`} className="rounded-lg border border-line bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-semibold text-fg">Scene {current.idx + 1}</h3>
              <span className="text-xs tabular-nums text-fg-muted">{ts(current.start_ms)}–{ts(current.end_ms)} · {((current.end_ms - current.start_ms) / 1000).toFixed(1)}s</span>
              {current.purpose && <Badge tone="accent">{current.purpose}</Badge>}
              {current.framing && <Badge>{current.framing.replace(/_/g, " ")}</Badge>}
            </div>
            <dl className="mt-3 space-y-3 text-sm">
              <div><dt className="text-xs text-fg-subtle">Visual (AI, from the representative frame)</dt><dd className="text-fg">{current.visualAnalyzed ? current.description : "This frame was not sent for visual analysis."}</dd></div>
              {current.textOverlays.length > 0 && <div><dt className="text-xs text-fg-subtle">On-screen text</dt><dd className="text-fg">{current.textOverlays.map((t) => `“${t}”`).join(" · ")}</dd></div>}
              <div><dt className="text-xs text-fg-subtle">Speech in this scene (transcript)</dt><dd className="text-fg">{current.transcript || "—"}</dd></div>
              {current.editingNotes && <div><dt className="text-xs text-fg-subtle">Editing observations (AI)</dt><dd className="text-fg">{current.editingNotes}</dd></div>}
              {current.score !== null && <div><dt className="text-xs text-fg-subtle">Scene-change score (ffmpeg)</dt><dd className="tabular-nums text-fg">{current.score.toFixed(2)}</dd></div>}
            </dl>
          </section>
        )}
      </div>

      {/* Proportional timeline */}
      <div>
        <div className="relative flex h-12 overflow-hidden rounded-md border border-line" role="list" aria-label="Scene timeline">
          {scenes.map((s) => (
            <button
              key={s.idx}
              type="button"
              role="listitem"
              onClick={() => seek(s.start_ms, s.idx)}
              aria-label={`Scene ${s.idx + 1}, ${ts(s.start_ms)} to ${ts(s.end_ms)}`}
              aria-current={s.idx === active ? "true" : undefined}
              style={{ width: `${((s.end_ms - s.start_ms) / Math.max(1, durationMs)) * 100}%`, backgroundImage: s.frameUrl ? `url(${s.frameUrl})` : undefined }}
              className={cn("relative h-full min-w-[6px] border-r border-bg bg-surface-3 bg-cover bg-center last:border-r-0 hover:brightness-125 focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", s.idx === active && "ring-2 ring-inset ring-accent")}
            />
          ))}
          {videoUrl && <span aria-hidden className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/90" style={{ left: `${Math.min(100, (now / Math.max(1, durationMs)) * 100)}%` }} />}
        </div>
        <div className="mt-1 flex justify-between text-[11px] tabular-nums text-fg-subtle"><span>0:00</span><span>{ts(durationMs)}</span></div>
      </div>

      {/* Scene list */}
      <ol className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {scenes.map((s) => (
          <li key={s.idx}>
            <button type="button" onClick={() => seek(s.start_ms, s.idx)} className={cn("flex w-full gap-3 rounded-md border p-2 text-left hover:border-line-strong", s.idx === active ? "border-accent bg-accent/5" : "border-line")}>
              <span className="h-14 w-20 shrink-0 overflow-hidden rounded bg-surface-3">
                {/* eslint-disable-next-line @next/next/no-img-element -- signed private URL */}
                {s.frameUrl && <img src={s.frameUrl} alt="" className="h-full w-full object-cover" loading="lazy" />}
              </span>
              <span className="min-w-0">
                <span className="block text-xs font-medium text-fg">Scene {s.idx + 1} · {ts(s.start_ms)}</span>
                <span className="line-clamp-2 text-xs text-fg-muted">{s.purpose ?? s.description ?? "—"}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      {/* Transcript */}
      <section aria-labelledby="transcript-heading">
        <h3 id="transcript-heading" className="mb-2 text-sm font-semibold text-fg">Transcript</h3>
        {segments.length === 0 ? (
          <p className="text-xs text-fg-subtle">No transcript for this analysis.</p>
        ) : (
          <ol className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {segments.map((sg, i) => {
              const playing = now >= sg.start_ms && now < sg.end_ms;
              return (
                <li key={i}>
                  <button type="button" onClick={() => seek(sg.start_ms)} className={cn("flex w-full gap-3 rounded px-2 py-1 text-left text-sm hover:bg-surface-2", playing && "bg-accent/10")}>
                    <span className="w-12 shrink-0 tabular-nums text-xs text-accent">{ts(sg.start_ms)}</span>
                    <span className="text-fg">{sg.text}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}
