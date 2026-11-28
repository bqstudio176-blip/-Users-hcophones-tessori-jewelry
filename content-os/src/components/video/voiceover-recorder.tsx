"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ACCEPT_ATTR } from "@/lib/video/media-types";
import { addVoiceoverTake } from "@/server/actions/video";
import { uploadMediaFile } from "./upload";

interface SceneText {
  id: string;
  title: string;
  spoken_text: string;
}

function pickMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]) if (MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

const extFor = (mime: string) => (mime.includes("mp4") ? "m4a" : mime.includes("ogg") ? "ogg" : "webm");

/**
 * Records a voiceover in the browser with the script as a teleprompter, or
 * accepts an uploaded recording. Each take is stored as a private media asset
 * and transcribed on the worker to time captions.
 */
export function VoiceoverRecorder({ projectId, scenes }: { projectId: string; scenes: SceneText[] }) {
  const router = useRouter();
  const [scope, setScope] = useState<string>("full");
  const [state, setState] = useState<"idle" | "recording" | "recorded" | "saving">("idle");
  const [elapsed, setElapsed] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<string>("");
  const [own, setOwn] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const supported = typeof window !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";

  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
    recRef.current?.stream.getTracks().forEach((t) => t.stop());
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const text = scope === "full" ? scenes.map((s) => s.spoken_text).filter(Boolean) : [scenes.find((s) => s.id === scope)?.spoken_text ?? ""];

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks.current = [];
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const b = new Blob(chunks.current, { type: rec.mimeType || mime || "audio/webm" });
        setBlob(b);
        setUrl(URL.createObjectURL(b));
        setState("recorded");
      };
      rec.start(1000);
      recRef.current = rec;
      setElapsed(0);
      timer.current = setInterval(() => setElapsed((s) => s + 1), 1000);
      setState("recording");
    } catch {
      setError("Microphone access was denied or is unavailable. You can upload a recording instead.");
    }
  }

  function stop() {
    if (timer.current) clearInterval(timer.current);
    recRef.current?.stop();
  }

  async function saveFile(file: File, origin: "recording" | "upload") {
    if (!own) return setError("Confirm the recording is your own voice or one you have the rights to use.");
    setState("saving");
    setError(null);
    const label = scope === "full" ? "Voiceover" : `Voiceover · ${scenes.find((s) => s.id === scope)?.title ?? "scene"}`;
    const up = await uploadMediaFile(file, { title: `${label} ${new Date().toLocaleString()}`, rightsConfirmed: true, origin, onPhase: setPhase });
    if (!up.ok) {
      setState(blob ? "recorded" : "idle");
      return setError(up.error);
    }
    setPhase("Queuing transcription…");
    const take = await addVoiceoverTake(projectId, up.assetId, scope === "full" ? null : scope);
    if (!take.ok) {
      setState("recorded");
      return setError(take.error);
    }
    setBlob(null);
    setUrl(null);
    setState("idle");
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs text-fg-subtle">
          <span className="mb-1 block">Record for</span>
          <select value={scope} onChange={(e) => setScope(e.target.value)} disabled={state === "recording"} className="h-9 rounded-md border border-line bg-surface-2 px-2 text-sm text-fg">
            <option value="full">The whole script</option>
            {scenes.map((s, i) => <option key={s.id} value={s.id}>Scene {i + 1}: {s.title}</option>)}
          </select>
        </label>
        {state === "recording" ? (
          <Button onClick={stop} variant="danger">Stop · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</Button>
        ) : (
          <Button onClick={start} disabled={!supported || state === "saving"}>{state === "recorded" ? "Record again" : "Start recording"}</Button>
        )}
        {state === "recording" && <span className="flex items-center gap-2 text-sm text-danger" role="status"><span className="size-2 animate-pulse rounded-full bg-danger" /> Recording</span>}
      </div>
      {!supported && <p className="text-xs text-fg-subtle">This browser cannot record audio. Upload a recording instead.</p>}

      <div aria-label="Teleprompter" className="max-h-72 overflow-y-auto rounded-xl border border-line bg-surface-2 p-5 text-xl leading-relaxed text-fg">
        {text.filter(Boolean).length ? text.map((p, i) => <p key={i} className="mb-4">{p}</p>) : <p className="text-base text-fg-subtle">This scene has no spoken text in the script.</p>}
      </div>

      {state === "recorded" && url && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <audio src={url} controls className="w-full" />
          <Button onClick={() => blob && saveFile(new File([blob], `take.${extFor(blob.type)}`, { type: blob.type.split(";")[0] }), "recording")}>Use this take</Button>
        </div>
      )}

      <label className="flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} className="mt-1 accent-[rgb(var(--color-accent))]" />
        <span>This is my own voice, or a recording I have the rights to use.</span>
      </label>
      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-3">
        <label className="text-xs text-fg-subtle">
          <span className="mb-1 block">Or upload a recording</span>
          <input type="file" accept={ACCEPT_ATTR} disabled={state === "saving" || state === "recording"} onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void saveFile(f, "upload");
            e.target.value = "";
          }} className="text-sm text-fg-muted file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-fg" />
        </label>
        {state === "saving" && <span className="flex items-center gap-2 text-sm text-fg-muted" role="status"><Spinner />{phase}</span>}
      </div>
    </div>
  );
}
