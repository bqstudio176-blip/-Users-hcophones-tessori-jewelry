"use client";

import { useActionState, useState } from "react";
import { SubmitButton } from "@/components/ui/submit-button";
import { cn } from "@/lib/cn";
import { IDLE } from "@/lib/types";
import { submitFeedback } from "@/server/actions/creative";

const REASONS = [
  ["not_relevant", "Not relevant"],
  ["too_generic", "Too generic"],
  ["too_long", "Too long"],
  ["too_commercial", "Too commercial"],
  ["wrong_tone", "Wrong tone"],
  ["needs_more_storytelling", "Needs more storytelling"],
  ["other", "Other"],
] as const;

/** Explicit feedback on a generated item. Stored with workspace + content version; never used for model training. */
export function FeedbackWidget({ targetType, targetId, targetVersion }: { targetType: string; targetId: string; targetVersion?: number }) {
  const [state, action] = useActionState(submitFeedback, IDLE);
  const [mode, setMode] = useState<"idle" | "negative">("idle");
  if (state.status === "success") return <p className="text-xs text-success" role="status">{state.message}</p>;
  const hidden = (
    <>
      <input type="hidden" name="target_type" value={targetType} />
      <input type="hidden" name="target_id" value={targetId} />
      <input type="hidden" name="target_version" value={targetVersion ?? ""} />
    </>
  );
  return (
    <div className="text-xs">
      {state.status === "error" && <p className="mb-1 text-danger" role="alert">{state.message}</p>}
      {mode === "idle" ? (
        <div className="flex items-center gap-2">
          <span className="text-fg-subtle">Was this useful?</span>
          <form action={action}>
            {hidden}
            <input type="hidden" name="rating" value="useful" />
            <input type="hidden" name="reasons" value="useful" />
            <SubmitButton size="sm" variant="ghost">👍 Useful</SubmitButton>
          </form>
          <button type="button" onClick={() => setMode("negative")} className="rounded px-2 py-1 text-fg-muted hover:bg-surface-2 hover:text-fg">👎 Not quite</button>
        </div>
      ) : (
        <form action={action} className="space-y-2 rounded-md border border-line bg-surface-2 p-2">
          {hidden}
          <input type="hidden" name="rating" value="not_useful" />
          <fieldset>
            <legend className="mb-1 text-fg-muted">What was wrong?</legend>
            <div className="flex flex-wrap gap-1">
              {REASONS.map(([id, label]) => (
                <label key={id} className={cn("cursor-pointer rounded-full border border-line px-2 py-0.5 has-[:checked]:border-accent has-[:checked]:bg-accent/10")}>
                  <input type="checkbox" name="reasons" value={id} className="sr-only" /> {label}
                </label>
              ))}
            </div>
          </fieldset>
          <label htmlFor={`c-${targetId}`} className="sr-only">Comment</label>
          <input id={`c-${targetId}`} name="comment" maxLength={1000} placeholder="Optional comment" className="h-8 w-full rounded border border-line bg-surface px-2" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setMode("idle")} className="rounded px-2 py-1 text-fg-muted hover:text-fg">Cancel</button>
            <SubmitButton size="sm" variant="outline">Send feedback</SubmitButton>
          </div>
        </form>
      )}
    </div>
  );
}
