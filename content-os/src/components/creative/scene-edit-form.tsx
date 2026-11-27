"use client";

import { useActionState } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { updateScene } from "@/server/actions/creative";

const SECTIONS = [["hook", "Hook"], ["opening", "Opening"], ["context", "Context"], ["main_development", "Main development"], ["supporting_arguments", "Supporting arguments"], ["transition", "Transition"], ["conclusion", "Conclusion"], ["cta", "CTA"]] as const;

export interface SceneValues {
  id: string;
  section: string;
  scene_title: string;
  estimated_duration_seconds: number;
  spoken_text: string;
  visual_direction: string;
  camera_direction: string;
  on_screen_text: string;
  audio_direction: string;
  transition: string;
  creative_purpose: string;
}

const area = "w-full rounded-md border border-line bg-surface-2 p-2 text-sm text-fg focus:outline-none focus:ring-2 focus:ring-ring/60";

export function SceneEditForm({ scene }: { scene: SceneValues }) {
  const [state, action] = useActionState(updateScene, IDLE);
  const fe = state.fieldErrors ?? {};
  const f = (name: keyof SceneValues, label: string, rows = 2, max = 2000) => (
    <label className="block text-xs text-fg-subtle">
      {label}
      <textarea name={name} defaultValue={String(scene[name] ?? "")} rows={rows} maxLength={max} className={`${area} mt-1`} />
      {fe[name] && <span className="text-danger">{fe[name]}</span>}
    </label>
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="sceneId" value={scene.id} />
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_7rem]">
        <label className="block text-xs text-fg-subtle">Scene title<input name="scene_title" defaultValue={scene.scene_title} maxLength={200} className={`${area} mt-1 h-9`} /></label>
        <label className="block text-xs text-fg-subtle">Section
          <select name="section" defaultValue={scene.section} className={`${area} mt-1 h-9`}>{SECTIONS.map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
        </label>
        <label className="block text-xs text-fg-subtle">Est. seconds<input name="estimated_duration_seconds" type="number" step="0.5" min="0.5" max="600" defaultValue={scene.estimated_duration_seconds} className={`${area} mt-1 h-9`} /></label>
      </div>
      {f("spoken_text", "Spoken text", 3, 5000)}
      <div className="grid gap-2 sm:grid-cols-2">
        {f("visual_direction", "Visual direction")}
        {f("camera_direction", "Camera direction", 2, 1000)}
        {f("on_screen_text", "On-screen text", 2, 500)}
        {f("audio_direction", "Audio direction", 2, 1000)}
        {f("transition", "Transition", 1, 300)}
        {f("creative_purpose", "Creative purpose", 1, 600)}
      </div>
      <div className="flex items-center justify-end gap-2">
        {state.message && <span className={`text-xs ${state.status === "error" ? "text-danger" : "text-success"}`} role="status">{state.message}</span>}
        <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save scene</SubmitButton>
      </div>
    </form>
  );
}
