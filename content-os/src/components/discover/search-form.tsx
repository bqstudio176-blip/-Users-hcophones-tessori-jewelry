"use client";

import { useActionState } from "react";
import { Field, Input, Select } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { CONTENT_FORMATS, REFERENCE_CATEGORIES } from "@/lib/discover/catalog";
import { IDLE } from "@/lib/types";
import { runSearch } from "@/server/actions/discover";

export interface ProviderOption {
  id: string;
  name: string;
  available: boolean;
  reason?: string;
}

export function SearchForm({ providers, defaults }: { providers: ProviderOption[]; defaults?: Partial<Record<"keywords" | "topic" | "niche" | "industry", string>> }) {
  const [state, action] = useActionState(runSearch, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="keywords" className="sr-only">Keywords</label>
        <Input name="keywords" placeholder="Search keywords, e.g. “morning routine hooks”" defaultValue={defaults?.keywords} error={fe.keywords} className="h-11 flex-1 text-base" />
        <SubmitButton size="lg" pendingLabel="Searching…">Search</SubmitButton>
      </div>
      {fe.keywords && <p role="alert" className="-mt-2 text-xs text-danger">{fe.keywords}</p>}
      <details className="group rounded-md border border-line bg-surface-2/50 p-3" open>
        <summary className="cursor-pointer text-xs font-medium text-fg-muted">Filters</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Topic" name="topic"><Input name="topic" defaultValue={defaults?.topic} maxLength={80} /></Field>
          <Field label="Niche" name="niche"><Input name="niche" defaultValue={defaults?.niche} maxLength={80} /></Field>
          <Field label="Industry" name="industry"><Input name="industry" defaultValue={defaults?.industry} maxLength={80} /></Field>
          <Field label="Format" name="format">
            <Select name="format" defaultValue="any">{CONTENT_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
          </Field>
          <Field label="Category (library)" name="category">
            <Select name="category" defaultValue=""><option value="">All</option>{REFERENCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
          </Field>
        </div>
        <fieldset className="mt-4">
          <legend className="text-xs font-medium text-fg-muted">Sources</legend>
          {fe.providers && <p role="alert" className="text-xs text-danger">{fe.providers}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {providers.map((p) => (
              <label key={p.id} title={p.reason} className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${p.available ? "cursor-pointer border-line has-[:checked]:border-accent has-[:checked]:bg-accent/10" : "cursor-not-allowed border-line opacity-50"}`}>
                <input type="checkbox" name="providers" value={p.id} defaultChecked={p.available && (p.id === "library" || p.id === "youtube")} disabled={!p.available} className="accent-[rgb(var(--color-accent))]" />
                {p.name}
                {!p.available && <span className="sr-only">(unavailable: {p.reason})</span>}
              </label>
            ))}
          </div>
        </fieldset>
      </details>
    </form>
  );
}
