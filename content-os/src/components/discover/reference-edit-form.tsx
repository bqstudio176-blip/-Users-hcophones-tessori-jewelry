"use client";

import { useActionState } from "react";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { REFERENCE_CATEGORIES } from "@/lib/discover/catalog";
import { IDLE } from "@/lib/types";
import { updateReference } from "@/server/actions/discover";

export function ReferenceEditForm({ r }: { r: { id: string; title: string; description: string | null; category: string | null; notes: string | null; tags: string[] } }) {
  const [state, action] = useActionState(updateReference, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="referenceId" value={r.id} />
      <Field label="Title" name="title" error={fe.title}><Input name="title" defaultValue={r.title} maxLength={200} required error={fe.title} /></Field>
      <Field label="Description" name="description" error={fe.description}><Textarea name="description" defaultValue={r.description ?? ""} maxLength={5000} error={fe.description} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" name="category" error={fe.category}>
          <Select name="category" defaultValue={r.category ?? ""}><option value="">None</option>{REFERENCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        </Field>
        <Field label="Tags" name="tags" error={fe.tags} hint="Comma-separated"><Input name="tags" defaultValue={r.tags.join(", ")} error={fe.tags} hasHint /></Field>
      </div>
      <Field label="Personal notes" name="notes" error={fe.notes}><Textarea name="notes" defaultValue={r.notes ?? ""} maxLength={10000} className="min-h-32" error={fe.notes} /></Field>
      <div className="flex justify-end"><SubmitButton pendingLabel="Saving…">Save changes</SubmitButton></div>
    </form>
  );
}
