"use server";

import { revalidatePath } from "next/cache";
import { requireWorkspacePermission } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { createClient } from "@/lib/supabase/server";

export async function disconnectSocialAccount(): Promise<void> {
  const ctx = await requireWorkspacePermission("social.manage");
  const supabase = await createClient();
  // RPC re-checks owner/admin and deletes credentials via cascade.
  const { error } = await supabase.rpc("disconnect_social_account", { p_workspace_id: ctx.workspace.id });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/settings/connections");
  revalidatePath("/dashboard");
}
