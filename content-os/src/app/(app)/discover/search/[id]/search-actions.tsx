"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { deleteSearch, saveResultToLibrary, saveSearch, unsaveSearch } from "@/server/actions/discover";

export function SaveSearchForm({ searchId, savedName }: { searchId: string; savedName: string | null }) {
  const [state, action] = useActionState(saveSearch, IDLE);
  if (savedName && state.status !== "success") {
    return (
      <form action={unsaveSearch} className="flex items-center gap-2">
        <input type="hidden" name="searchId" value={searchId} />
        <span className="text-sm text-fg-muted">Saved as “{savedName}”</span>
        <Button type="submit" variant="ghost" size="sm">Unsave</Button>
      </form>
    );
  }
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <input type="hidden" name="searchId" value={searchId} />
      <div>
        <label htmlFor="name" className="sr-only">Search name</label>
        <Input name="name" placeholder="Name this search" maxLength={80} error={state.fieldErrors?.name} className="h-9 sm:w-56" />
        {state.fieldErrors?.name && <p className="mt-1 text-xs text-danger">{state.fieldErrors.name}</p>}
      </div>
      <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save search</SubmitButton>
      <FormMessage state={state.status === "success" ? state : { status: "idle" }} />
    </form>
  );
}

export function SaveResultButton({ resultId }: { resultId: string }) {
  return (
    <form action={saveResultToLibrary}>
      <input type="hidden" name="resultId" value={resultId} />
      <SubmitButton size="sm" variant="outline" pendingLabel="Saving…">Save to library</SubmitButton>
    </form>
  );
}

export function DeleteSearchButton({ searchId }: { searchId: string }) {
  return (
    <form action={deleteSearch}>
      <input type="hidden" name="searchId" value={searchId} />
      <button type="submit" aria-label="Delete search from history" className="rounded p-1 text-xs text-fg-subtle hover:bg-surface-2 hover:text-danger">✕</button>
    </form>
  );
}
