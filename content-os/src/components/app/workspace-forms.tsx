"use client";

import { useActionState, useState } from "react";
import { Field, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { slugify } from "@/lib/validation";
import { acceptInvitation, createWorkspace } from "@/server/actions/workspace";

export function CreateWorkspaceForm() {
  const [state, action] = useActionState(createWorkspace, IDLE);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field label="Workspace name" name="name" error={fe.name} hint="Usually your brand, client or team name.">
        <Input
          name="name"
          required
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugify(e.target.value));
          }}
          error={fe.name}
          hasHint
        />
      </Field>
      <Field label="Workspace URL" name="slug" error={fe.slug} hint="Lowercase letters, numbers and dashes.">
        <div className="flex items-center rounded-md border border-line bg-surface-2 focus-within:ring-2 focus-within:ring-ring/60">
          <span className="select-none pl-3 text-sm text-fg-subtle">contentos.app/</span>
          <Input
            name="slug"
            required
            maxLength={48}
            value={slug}
            onChange={(e) => {
              setSlugTouched(true);
              setSlug(e.target.value.toLowerCase());
            }}
            error={fe.slug}
            hasHint
            className="border-0 bg-transparent pl-0.5 focus:ring-0"
          />
        </div>
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating workspace…">Create workspace</SubmitButton>
    </form>
  );
}

export function AcceptInvitationForm({ token }: { token: string }) {
  const [state, action] = useActionState(acceptInvitation, IDLE);
  return (
    <form action={action} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton className="w-full" pendingLabel="Joining…">Accept invitation</SubmitButton>
    </form>
  );
}
