"use server";

import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { creditAdjustmentSchema, fieldErrors } from "@/lib/validation";

export async function adjustCredits(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePlatformAdmin();
  const parsed = creditAdjustmentSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    amount: formData.get("amount"),
    reason: formData.get("reason"),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  // admin_adjust_credits() re-checks is_platform_admin() in the database.
  const { data, error } = await supabase.rpc("admin_adjust_credits", {
    p_workspace_id: parsed.data.workspaceId,
    p_amount: parsed.data.amount,
    p_reason: parsed.data.reason,
  });
  if (error) return { status: "error", message: dbErrorMessage(error) };
  revalidatePath(`/admin/workspaces/${parsed.data.workspaceId}`);
  return { status: "success", message: `Adjustment recorded. New balance: ${(data as { balance_after: number }).balance_after}.` };
}
