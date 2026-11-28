"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { saveTimeline } from "@/server/actions/video";
import { captionsFromWords, estimateCaptions } from "@/server/video/captions";
import {
  alignScenesToWords,
  CAPTION_STYLES,
  sceneStarts,
  TEXT_STYLES,
  timelineDuration,
  validateTimeline,
  VIDEO_LIMITS,
  type AssetInfo,
  type CaptionLine,
  type Timeline,
  type TimelineScene,
} from "@/server/video/timeline";
import { PreviewPlayer } from "./preview-player";
import type { EditorAsset, EditorTake } from "./types";

const control = "h-9 w-full rounded-md border border-line bg-surface-2 px-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-ring/60";
const small = "rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2 disabled:opacity-40";
const newId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 40);
const r2 = (n: number) => Math.round(n * 100) / 100;
const clampDur = (n: number) => Math.min(VIDEO_LIMITS.maxSceneSeconds, Math.max(VIDEO_LIMITS.minSceneSeconds, r2(n)));

function Labeled({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block text-xs text-fg-subtle">
      <span className="mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-fg-subtle">{hint}</span>}
    </label>
  );
}

function Range({ value, onChange, min, max, step, label, display }: { value: number; onChange: (n: number) => void; min: number; max: number; step: number; label: string; display?: string }) {
  return (
    <label className="block text-xs text-fg-subtle">
      <span className="mb-1 flex justify-between"><span>{label}</span><span className="tabular-nums text-fg-muted">{display ?? value}</span></span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[rgb(var(--color-accent))]" />
    </label>
  );
}

export function VideoEditor({ projectId, initial, initialVersion, assets: assetList, takes, archived }: {
  projectId: string;
  initial: Timeline;
  initialVersion: number;
  assets: EditorAsset[];
  takes: EditorTake[];
  archived: boolean;
}) {
  const router = useRouter();
  const [timeline, setTimeline] = useState<Timeline>(initial);
  const [version, setVersion] = useState(initialVersion);
  const [saved, setSaved] = useState(JSON.stringify(initial));
  const [sel, setSel] = useState(0);
  const [panel, setPanel] = useState<"scene" | "voice" | "music" | "captions">("scene");
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "error" | "ok" | "conflict"; message?: string }>({ kind: "idle" });
  const [note, setNote] = useState("");

  const assets = useMemo(() => new Map(assetList.map((a) => [a.id, a])), [assetList]);
  const info = useMemo(() => new Map<string, AssetInfo>(assetList.map((a) => [a.id, { id: a.id, kind: a.kind, status: a.status, duration_seconds: a.duration, has_audio: a.hasAudio }])), [assetList]);
  const problems = useMemo(() => validateTimeline(timeline, info), [timeline, info]);
  const dirty = JSON.stringify(timeline) !== saved;
  const total = timelineDuration(timeline);
  const starts = sceneStarts(timeline);
  const scene = timeline.scenes[Math.min(sel, timeline.scenes.length - 1)]!;
  const visuals = assetList.filter((a) => a.status === "ready" && (a.kind === "video" || a.kind === "image"));
  const audios = assetList.filter((a) => a.status === "ready" && (a.kind === "audio" || (a.kind === "video" && a.hasAudio)));
  const fullTakes = takes.filter((t) => !t.sceneKey && assets.get(t.assetId)?.status === "ready");

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const set = (fn: (t: Timeline) => Timeline) => setTimeline((t) => fn(structuredClone(t)));
  const patchScene = (i: number, patch: Partial<TimelineScene>) => set((t) => ({ ...t, scenes: t.scenes.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));

  function move(i: number, d: -1 | 1) {
    const j = i + d;
    if (j < 0 || j >= timeline.scenes.length) return;
    set((t) => {
      const s = [...t.scenes];
      [s[i], s[j]] = [s[j]!, s[i]!];
      return { ...t, scenes: s };
    });
    setSel(j);
  }
  function duplicate(i: number) {
    if (timeline.scenes.length >= VIDEO_LIMITS.maxScenes) return;
    set((t) => ({ ...t, scenes: [...t.scenes.slice(0, i + 1), { ...structuredClone(t.scenes[i]!), id: newId(), voice: null }, ...t.scenes.slice(i + 1)] }));
    setSel(i + 1);
  }
  function split(i: number) {
    const s = timeline.scenes[i]!;
    if (s.duration < 1 || timeline.scenes.length >= VIDEO_LIMITS.maxScenes) return;
    const half = r2(s.duration / 2);
    const second: TimelineScene = { ...structuredClone(s), id: newId(), duration: r2(s.duration - half), voice: null, text: null, script_scene_id: s.script_scene_id };
    if (second.visual?.kind === "video") second.visual.trim_start = r2(second.visual.trim_start + half);
    set((t) => ({ ...t, scenes: [...t.scenes.slice(0, i), { ...s, duration: half, transition: "cut" }, second, ...t.scenes.slice(i + 1)] }));
  }
  function remove(i: number) {
    if (timeline.scenes.length <= 1) return;
    set((t) => ({ ...t, scenes: t.scenes.filter((_, j) => j !== i) }));
    setSel(Math.max(0, i - 1));
  }
  function addScene() {
    if (timeline.scenes.length >= VIDEO_LIMITS.maxScenes) return;
    set((t) => ({ ...t, scenes: [...t.scenes, { id: newId(), script_scene_id: null, title: `Scene ${t.scenes.length + 1}`, spoken_text: "", duration: 3, visual: null, voice: null, transition: "cut", text: null }] }));
    setSel(timeline.scenes.length);
  }
  function chooseVisual(a: EditorAsset) {
    const prev = scene.visual;
    patchScene(sel, {
      visual: { asset_id: a.id, kind: a.kind === "image" ? "image" : "video", trim_start: 0, fit: prev?.fit ?? "fill", focal_x: prev?.focal_x ?? 0.5, focal_y: prev?.focal_y ?? 0.5, ken_burns: a.kind === "image", volume: 0 },
    });
  }

  function fitToVoice() {
    if (timeline.voiceover) {
      const take = takes.find((t) => t.id === timeline.voiceover!.take_id);
      if (!take?.words.length) return setStatus({ kind: "error", message: "This voiceover has no word timings (transcription unavailable). Adjust durations manually." });
      set((t) => alignScenesToWords(t, take.words, t.voiceover!.offset));
      return setStatus({ kind: "ok", message: "Scene durations now follow the measured voiceover." });
    }
    set((t) => ({ ...t, scenes: t.scenes.map((s) => (s.voice && assets.get(s.voice.asset_id)?.duration ? { ...s, duration: clampDur(assets.get(s.voice.asset_id)!.duration! + 0.3) } : s)) }));
    setStatus({ kind: "ok", message: "Scenes with their own voice now match the recording length." });
  }

  function generateCaptions() {
    const lines: CaptionLine[] = [];
    let source: Timeline["captions"]["source"] = "estimated";
    if (timeline.voiceover) {
      const take = takes.find((t) => t.id === timeline.voiceover!.take_id);
      if (take?.words.length) {
        lines.push(...captionsFromWords(take.words, timeline.voiceover.offset, timeline.format, total));
        source = "voiceover";
      }
    } else if (timeline.scenes.some((s) => s.voice?.take_id)) {
      timeline.scenes.forEach((s, i) => {
        const take = s.voice?.take_id ? takes.find((t) => t.id === s.voice!.take_id) : undefined;
        if (take?.words.length) lines.push(...captionsFromWords(take.words.filter((w) => w.start < s.duration), starts[i]!, timeline.format, Math.min(total, starts[i]! + s.duration)));
      });
      if (lines.length) source = "voiceover";
    }
    const final = lines.length ? lines : estimateCaptions(timeline);
    set((t) => ({ ...t, captions: { ...t.captions, enabled: true, lines: final.slice(0, 600), source } }));
    setStatus({ kind: "ok", message: source === "voiceover" ? "Captions timed from the measured voiceover." : "Captions generated with ESTIMATED timing from scene durations (no transcribed voiceover)." });
  }

  async function save(snapshot: boolean) {
    setStatus({ kind: "saving" });
    const r = await saveTimeline(projectId, timeline, version, snapshot, note);
    if (!r.ok) return setStatus({ kind: r.conflict ? "conflict" : "error", message: r.error });
    setVersion(r.version);
    setSaved(JSON.stringify(timeline));
    setNote("");
    setStatus({ kind: "ok", message: snapshot ? "Saved as a new version." : "Saved." });
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {archived && <Alert tone="warning">This video is archived. Unarchive it on the Render tab to edit.</Alert>}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-3">
        <span className="text-sm text-fg">{timeline.scenes.length} scenes · <span className="tabular-nums">{total.toFixed(1)}s</span> <span className="text-fg-subtle">/ max {VIDEO_LIMITS.maxOutputSeconds}s</span></span>
        {dirty ? <Badge tone="warning">Unsaved changes</Badge> : <Badge>Saved · v{version}</Badge>}
        {problems.length > 0 && <Badge tone="danger">{problems.length} issue{problems.length === 1 ? "" : "s"}</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Version note (optional)" aria-label="Version note" className={cn(control, "w-48")} />
          <Button size="sm" variant="outline" disabled={status.kind === "saving" || archived || problems.length > 0} onClick={() => save(true)}>Save version</Button>
          <Button size="sm" disabled={status.kind === "saving" || !dirty || archived || problems.length > 0} onClick={() => save(false)}>{status.kind === "saving" ? <><Spinner /> Saving…</> : "Save"}</Button>
        </div>
      </div>
      {status.kind === "error" && <Alert tone="danger">{status.message}</Alert>}
      {status.kind === "conflict" && <Alert tone="warning">{status.message} <button type="button" className="underline" onClick={() => router.refresh()}>Reload</button></Alert>}
      {status.kind === "ok" && <Alert tone="success">{status.message}</Alert>}
      {problems.length > 0 && <Alert tone="danger" title="Fix before saving">{problems.slice(0, 6).map((p) => <p key={p}>{p}</p>)}</Alert>}

      <div className="grid gap-4 xl:grid-cols-[16rem_1fr_20rem]">
        {/* Scene list */}
        <section aria-label="Scenes" className="space-y-2">
          <ol className="space-y-2">
            {timeline.scenes.map((s, i) => {
              const a = s.visual ? assets.get(s.visual.asset_id) : undefined;
              return (
                <li key={s.id}>
                  <div className={cn("rounded-lg border p-2", i === sel ? "border-accent bg-surface-2" : "border-line bg-surface")}>
                    <button type="button" onClick={() => { setSel(i); setPanel("scene"); }} className="flex w-full items-center gap-2 text-left" aria-current={i === sel}>
                      <span className="grid h-12 w-9 shrink-0 place-items-center overflow-hidden rounded bg-black text-[10px] text-white/60">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {a?.thumbUrl ? <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" /> : i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm text-fg">{i + 1}. {s.title || "Untitled"}</span>
                        <span className="block text-[11px] text-fg-subtle">{starts[i]!.toFixed(1)}s · {s.duration}s{s.transition === "crossfade" ? " · fade" : ""}{!s.visual ? " · no media" : ""}{s.voice ? " · voice" : ""}</span>
                      </span>
                    </button>
                    {i === sel && (
                      <div className="mt-1 flex flex-wrap">
                        <button type="button" className={small} onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                        <button type="button" className={small} onClick={() => move(i, 1)} disabled={i === timeline.scenes.length - 1} aria-label="Move down">↓</button>
                        <button type="button" className={small} onClick={() => duplicate(i)}>Duplicate</button>
                        <button type="button" className={small} onClick={() => split(i)} disabled={s.duration < 1}>Split</button>
                        <button type="button" className={cn(small, "text-danger")} onClick={() => remove(i)} disabled={timeline.scenes.length <= 1}>Delete</button>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          <Button size="sm" variant="outline" className="w-full" onClick={addScene} disabled={timeline.scenes.length >= VIDEO_LIMITS.maxScenes}>+ Add scene</Button>
        </section>

        {/* Preview */}
        <section aria-label="Preview" className="mx-auto w-full max-w-sm">
          <PreviewPlayer timeline={timeline} assets={assets} />
        </section>

        {/* Inspector */}
        <section aria-label="Inspector" className="rounded-xl border border-line bg-surface p-3">
          <div role="tablist" className="mb-3 flex gap-1">
            {(["scene", "voice", "music", "captions"] as const).map((p) => (
              <button key={p} role="tab" aria-selected={panel === p} type="button" onClick={() => setPanel(p)} className={cn("rounded-md px-2 py-1 text-xs capitalize", panel === p ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2")}>{p === "voice" ? "Voiceover" : p}</button>
            ))}
          </div>

          {panel === "scene" && (
            <div className="space-y-3">
              <Labeled label="Title"><input className={control} value={scene.title} maxLength={200} onChange={(e) => patchScene(sel, { title: e.target.value })} /></Labeled>
              <div className="grid grid-cols-2 gap-2">
                <Labeled label="Duration (s)"><input className={control} type="number" min={0.5} max={60} step={0.1} value={scene.duration} onChange={(e) => patchScene(sel, { duration: clampDur(Number(e.target.value) || 0.5) })} /></Labeled>
                <Labeled label="Transition out">
                  <select className={control} value={scene.transition} onChange={(e) => patchScene(sel, { transition: e.target.value as "cut" | "crossfade" })}><option value="cut">Cut</option><option value="crossfade">Crossfade (0.5s)</option></select>
                </Labeled>
              </div>
              <div>
                <p className="mb-1 text-xs text-fg-subtle">Media</p>
                {visuals.length === 0 ? <p className="text-xs text-fg-muted">No ready clips or images yet — upload them in the Media library.</p> : (
                  <div className="grid max-h-44 grid-cols-4 gap-1 overflow-y-auto">
                    {visuals.map((a) => (
                      <button key={a.id} type="button" onClick={() => chooseVisual(a)} title={a.title} aria-label={`Use ${a.title}`} className={cn("relative aspect-[9/16] overflow-hidden rounded border bg-black", scene.visual?.asset_id === a.id ? "border-accent ring-2 ring-accent" : "border-line")}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {a.thumbUrl ? <img src={a.thumbUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px] text-white/60">{a.kind}</span>}
                        <span className="absolute bottom-0 left-0 right-0 truncate bg-black/60 px-0.5 text-[9px] text-white">{a.kind === "video" && a.duration ? `${a.duration.toFixed(0)}s` : a.kind}</span>
                      </button>
                    ))}
                  </div>
                )}
                {scene.visual && <button type="button" className={cn(small, "mt-1")} onClick={() => patchScene(sel, { visual: null })}>Remove media</button>}
              </div>
              {scene.visual && (
                <div className="space-y-2 rounded-md bg-surface-2 p-2">
                  {scene.visual.kind === "video" && (
                    <Labeled label="Start clip at (s)" hint={assets.get(scene.visual.asset_id)?.duration ? `Clip length ${assets.get(scene.visual.asset_id)!.duration!.toFixed(1)}s` : undefined}>
                      <input className={control} type="number" min={0} step={0.1} value={scene.visual.trim_start} onChange={(e) => patchScene(sel, { visual: { ...scene.visual!, trim_start: Math.max(0, r2(Number(e.target.value) || 0)) } })} />
                    </Labeled>
                  )}
                  <Labeled label="Fit">
                    <select className={control} value={scene.visual.fit} onChange={(e) => patchScene(sel, { visual: { ...scene.visual!, fit: e.target.value as "fill" | "fit_blur" } })}><option value="fill">Fill frame (crop)</option><option value="fit_blur">Fit with blurred background</option></select>
                  </Labeled>
                  {scene.visual.fit === "fill" && (
                    <div className="grid grid-cols-2 gap-2">
                      <Range label="Focus X" min={0} max={1} step={0.05} value={scene.visual.focal_x} onChange={(n) => patchScene(sel, { visual: { ...scene.visual!, focal_x: n } })} />
                      <Range label="Focus Y" min={0} max={1} step={0.05} value={scene.visual.focal_y} onChange={(n) => patchScene(sel, { visual: { ...scene.visual!, focal_y: n } })} />
                    </div>
                  )}
                  {scene.visual.kind === "image" && <label className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" checked={scene.visual.ken_burns} onChange={(e) => patchScene(sel, { visual: { ...scene.visual!, ken_burns: e.target.checked } })} className="accent-[rgb(var(--color-accent))]" />Slow zoom (Ken Burns)</label>}
                  {scene.visual.kind === "video" && <Range label="Clip audio" min={0} max={1} step={0.05} value={scene.visual.volume} display={`${Math.round(scene.visual.volume * 100)}%`} onChange={(n) => patchScene(sel, { visual: { ...scene.visual!, volume: n } })} />}
                </div>
              )}
              <div className="space-y-2">
                <Labeled label="On-screen text"><textarea className={cn(control, "h-16 py-1")} maxLength={300} value={scene.text?.content ?? ""} onChange={(e) => patchScene(sel, { text: e.target.value ? { content: e.target.value, style: scene.text?.style ?? "bold", position: scene.text?.position ?? "top" } : null })} /></Labeled>
                {scene.text && (
                  <div className="grid grid-cols-2 gap-2">
                    <select aria-label="Text style" className={control} value={scene.text.style} onChange={(e) => patchScene(sel, { text: { ...scene.text!, style: e.target.value } })}>{TEXT_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
                    <select aria-label="Text position" className={control} value={scene.text.position} onChange={(e) => patchScene(sel, { text: { ...scene.text!, position: e.target.value as "top" | "center" | "bottom" } })}><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select>
                  </div>
                )}
              </div>
              <Labeled label="Scene voice" hint="Per-scene recording (use either this or one voiceover for the whole video).">
                <select className={control} value={scene.voice?.asset_id ?? ""} disabled={Boolean(timeline.voiceover)} onChange={(e) => {
                  const a = e.target.value;
                  const take = takes.find((t) => t.assetId === a && t.sceneKey === scene.id);
                  patchScene(sel, { voice: a ? { asset_id: a, take_id: take?.id ?? null, volume: 1 } : null });
                }}>
                  <option value="">None</option>
                  {audios.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </Labeled>
              {scene.spoken_text && <p className="rounded-md bg-surface-2 p-2 text-xs text-fg-muted"><span className="text-fg-subtle">Script:</span> {scene.spoken_text}</p>}
            </div>
          )}

          {panel === "voice" && (
            <div className="space-y-3">
              <Labeled label="Voiceover for the whole video" hint="Record takes on the Voiceover tab. Takes are transcribed to time captions.">
                <select className={control} value={timeline.voiceover?.take_id ?? (timeline.voiceover ? `asset:${timeline.voiceover.asset_id}` : "")} onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return set((t) => ({ ...t, voiceover: null }));
                  const take = fullTakes.find((t) => t.id === v);
                  const assetId = take ? take.assetId : v.replace(/^asset:/, "");
                  set((t) => ({ ...t, scenes: t.scenes.map((s) => ({ ...s, voice: null })), voiceover: { asset_id: assetId, take_id: take?.id ?? null, volume: t.voiceover?.volume ?? 1, offset: t.voiceover?.offset ?? 0 } }));
                }}>
                  <option value="">None</option>
                  {fullTakes.length > 0 && <optgroup label="Recorded takes">{fullTakes.map((t) => <option key={t.id} value={t.id}>Take {new Date(t.createdAt).toLocaleString()}{t.similarity !== null ? ` · ${Math.round(t.similarity * 100)}% match` : ""}</option>)}</optgroup>}
                  <optgroup label="Audio files">{audios.map((a) => <option key={a.id} value={`asset:${a.id}`}>{a.title}</option>)}</optgroup>
                </select>
              </Labeled>
              {timeline.voiceover && (
                <>
                  <Range label="Voice volume" min={0} max={2} step={0.05} value={timeline.voiceover.volume} display={`${Math.round(timeline.voiceover.volume * 100)}%`} onChange={(n) => set((t) => ({ ...t, voiceover: { ...t.voiceover!, volume: n } }))} />
                  <Labeled label="Start voice at video time (s)"><input className={control} type="number" min={0} step={0.1} value={timeline.voiceover.offset} onChange={(e) => set((t) => ({ ...t, voiceover: { ...t.voiceover!, offset: Math.max(0, r2(Number(e.target.value) || 0)) } }))} /></Labeled>
                </>
              )}
              <Button size="sm" variant="outline" className="w-full" onClick={fitToVoice} disabled={!timeline.voiceover && !timeline.scenes.some((s) => s.voice)}>Fit scene durations to the voice</Button>
              <p className="text-[11px] text-fg-subtle">Uses measured word timestamps from the transcription (or recording lengths for per-scene voice). Nothing changes until you save.</p>
            </div>
          )}

          {panel === "music" && (
            <div className="space-y-3">
              <Labeled label="Music track" hint="Your own or properly licensed music only — upload it to the Media library.">
                <select className={control} value={timeline.music?.asset_id ?? ""} onChange={(e) => set((t) => ({ ...t, music: e.target.value ? { asset_id: e.target.value, start: 0, volume: 0.4, fade_in: 0.5, fade_out: 1.5, duck: true, ...(t.music ? { ...t.music, asset_id: e.target.value } : {}) } : null }))}>
                  <option value="">None</option>
                  {audios.map((a) => <option key={a.id} value={a.id}>{a.title}</option>)}
                </select>
              </Labeled>
              {timeline.music && (
                <>
                  <Labeled label="Start track at (s)"><input className={control} type="number" min={0} step={0.5} value={timeline.music.start} onChange={(e) => set((t) => ({ ...t, music: { ...t.music!, start: Math.max(0, r2(Number(e.target.value) || 0)) } }))} /></Labeled>
                  <Range label="Music volume" min={0} max={1} step={0.05} value={timeline.music.volume} display={`${Math.round(timeline.music.volume * 100)}%`} onChange={(n) => set((t) => ({ ...t, music: { ...t.music!, volume: n } }))} />
                  <div className="grid grid-cols-2 gap-2">
                    <Range label="Fade in" min={0} max={10} step={0.5} value={timeline.music.fade_in} display={`${timeline.music.fade_in}s`} onChange={(n) => set((t) => ({ ...t, music: { ...t.music!, fade_in: n } }))} />
                    <Range label="Fade out" min={0} max={10} step={0.5} value={timeline.music.fade_out} display={`${timeline.music.fade_out}s`} onChange={(n) => set((t) => ({ ...t, music: { ...t.music!, fade_out: n } }))} />
                  </div>
                  <label className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" checked={timeline.music.duck} onChange={(e) => set((t) => ({ ...t, music: { ...t.music!, duck: e.target.checked } }))} className="accent-[rgb(var(--color-accent))]" />Lower music automatically under the voice</label>
                </>
              )}
            </div>
          )}

          {panel === "captions" && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" checked={timeline.captions.enabled} onChange={(e) => set((t) => ({ ...t, captions: { ...t.captions, enabled: e.target.checked } }))} className="accent-[rgb(var(--color-accent))]" />Captions</label>
              {timeline.captions.enabled && (
                <>
                  <label className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" checked={timeline.captions.burn_in} onChange={(e) => set((t) => ({ ...t, captions: { ...t.captions, burn_in: e.target.checked } }))} className="accent-[rgb(var(--color-accent))]" />Burn into the video (an SRT file is always exported)</label>
                  <div className="grid grid-cols-2 gap-2">
                    <select aria-label="Caption style" className={control} value={timeline.captions.style} onChange={(e) => set((t) => ({ ...t, captions: { ...t.captions, style: e.target.value } }))}>{CAPTION_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select>
                    <select aria-label="Caption position" className={control} value={timeline.captions.position} onChange={(e) => set((t) => ({ ...t, captions: { ...t.captions, position: e.target.value as "bottom" | "center" | "lower_third" } }))}><option value="bottom">Bottom</option><option value="lower_third">Lower third</option><option value="center">Center</option></select>
                  </div>
                  <a href={`/api/video/${projectId}/captions`} className="block text-center text-xs text-accent">Download SRT of saved captions</a>
                  <Button size="sm" variant="outline" className="w-full" onClick={generateCaptions}>{timeline.captions.lines.length ? "Regenerate captions" : "Generate captions"}</Button>
                  <p className="text-[11px] text-fg-subtle">
                    Timing: {timeline.captions.lines.length === 0 ? "none yet" : timeline.captions.source === "voiceover" ? "measured from the voiceover" : timeline.captions.source === "estimated" ? "ESTIMATED from scene durations" : "edited manually"}.
                    {timeline.captions.style === "highlight" && " Word highlighting needs measured timing."}
                  </p>
                  <ol className="max-h-72 space-y-1 overflow-y-auto">
                    {timeline.captions.lines.map((l, i) => (
                      <li key={i} className="flex items-center gap-1">
                        <span className="w-16 shrink-0 text-[10px] tabular-nums text-fg-subtle">{l.start.toFixed(1)}–{l.end.toFixed(1)}</span>
                        <input aria-label={`Caption ${i + 1}`} className={cn(control, "h-8 text-xs")} value={l.text} maxLength={200} onChange={(e) => set((t) => ({ ...t, captions: { ...t.captions, source: t.captions.source === "estimated" ? "estimated" : "manual", lines: t.captions.lines.map((x, j) => (j === i ? { ...x, text: e.target.value, words: undefined } : x)) } }))} />
                        <button type="button" className={cn(small, "text-danger")} aria-label={`Delete caption ${i + 1}`} onClick={() => set((t) => ({ ...t, captions: { ...t.captions, lines: t.captions.lines.filter((_, j) => j !== i) } }))}>×</button>
                      </li>
                    ))}
                  </ol>
                </>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
