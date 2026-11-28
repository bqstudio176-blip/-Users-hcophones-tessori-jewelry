"use client";

import { useActionState, type ReactNode } from "react";
import { Alert } from "@/components/ui/alert";
import type { ButtonVariant } from "@/components/ui/button";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE, type ActionState } from "@/lib/types";

/**
 * Generic form for ActionState server actions: shows pending, success, error
 * and field-level errors. Children are the (server- or client-rendered) fields.
 */
export function ActionForm({
  action,
  children,
  submitLabel,
  pendingLabel,
  variant = "primary",
  size = "md",
  className = "space-y-4",
  footer,
}: {
  action: (prev: ActionState, fd: FormData) => Promise<ActionState>;
  children?: ReactNode;
  submitLabel: string;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  className?: string;
  footer?: ReactNode;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={formAction} className={className} noValidate>
      {state.message && <Alert tone={state.status === "error" ? "danger" : "success"}>{state.message}</Alert>}
      {Object.keys(fe).length > 0 && (
        <Alert tone="danger" title="Please fix the following">
          <ul className="list-disc pl-4">{Object.entries(fe).map(([k, v]) => <li key={k}><span className="font-medium">{k.replace(/_/g, " ")}</span>: {v}</li>)}</ul>
        </Alert>
      )}
      {children}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {footer}
        <SubmitButton variant={variant} size={size} pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
      </div>
    </form>
  );
}
