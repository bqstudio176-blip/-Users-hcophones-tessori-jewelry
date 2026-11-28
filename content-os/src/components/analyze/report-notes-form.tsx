"use client";

import { useActionState } from "react";
import { Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { updateReportNotes } from "@/server/actions/analyze";

export function ReportNotesForm({ analysisId, notes }: { analysisId: string; notes: string | null }) {
  const [state, action] = useActionState(updateReportNotes, IDLE);
  return (
    <form action={action} className="space-y-3">
      <FormMessage state={state} />
      <input type="hidden" name="analysisId" value={analysisId} />
      <label htmlFor="notes" className="sr-only">Personal notes</label>
      <Textarea name="notes" defaultValue={notes ?? ""} maxLength={10000} placeholder="What will you reuse from this reference?" className="min-h-28" error={state.fieldErrors?.notes} />
      <div className="flex justify-end"><SubmitButton size="sm" pendingLabel="Saving…">Save notes</SubmitButton></div>
    </form>
  );
}
