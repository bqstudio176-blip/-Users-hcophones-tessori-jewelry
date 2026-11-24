"use client";

import { useActionState, useState } from "react";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { requestAnalysis } from "@/server/actions/analyze";

/** One idempotency key per rendered form: double-clicks never create (or charge) twice. */
export function RequestAnalysisForm({ referenceId, cost, label = "Analyze video", variant = "primary" }: { referenceId: string; cost: number; label?: string; variant?: "primary" | "outline" }) {
  const [state, action] = useActionState(requestAnalysis, IDLE);
  const [key] = useState(() => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`));
  return (
    <form action={action} className="space-y-2">
      <FormMessage state={state} />
      <input type="hidden" name="referenceId" value={referenceId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <SubmitButton variant={variant} pendingLabel="Queuing…">{label} · {cost} credits</SubmitButton>
    </form>
  );
}
