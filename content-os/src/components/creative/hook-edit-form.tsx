"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { updateHook } from "@/server/actions/creative";

export function HookEditForm({ hookId, text, original }: { hookId: string; text: string; original: string }) {
  const [state, action] = useActionState(updateHook, IDLE);
  const [editing, setEditing] = useState(false);
  if (!editing) {
    return (
      <div className="flex items-start justify-between gap-2">
        <p className="text-base font-medium text-fg">“{text}”</p>
        <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
      </div>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="hookId" value={hookId} />
      <label htmlFor={`h-${hookId}`} className="sr-only">Hook text</label>
      <textarea id={`h-${hookId}`} name="text" defaultValue={text} maxLength={400} className="min-h-20 w-full rounded-md border border-line bg-surface-2 p-2 text-sm text-fg" />
      {text !== original && <p className="text-xs text-fg-subtle">Original AI text: “{original}”</p>}
      {state.message && <p className={`text-xs ${state.status === "error" ? "text-danger" : "text-success"}`}>{state.message}</p>}
      {state.fieldErrors?.text && <p className="text-xs text-danger">{state.fieldErrors.text}</p>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Close</Button>
        <SubmitButton size="sm" pendingLabel="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
}
