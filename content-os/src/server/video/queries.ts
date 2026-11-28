import "server-only";
import { createClient } from "@/lib/supabase/server";

/** Bytes used by the workspace's media (failed uploads excluded) and the plan limit. */
export async function storageUsage(workspaceId: string): Promise<{ used: number; limit: number }> {
  const supabase = await createClient();
  const [{ data: assets }, { data: sub }] = await Promise.all([
    supabase.from("media_assets").select("size_bytes").eq("workspace_id", workspaceId).neq("status", "failed"),
    supabase.from("subscriptions").select("plan_id").eq("workspace_id", workspaceId).maybeSingle(),
  ]);
  const { data: lim } = await supabase.from("media_storage_limits").select("max_bytes").eq("plan_id", sub?.plan_id ?? "free").maybeSingle();
  return { used: (assets ?? []).reduce((n, a) => n + Number(a.size_bytes), 0), limit: Number(lim?.max_bytes ?? 2 * 1024 ** 3) };
}

export const VIDEO_STATUS_LABEL: Record<string, string> = { draft: "Draft", ready: "Ready to publish", archived: "Archived" };
export const RENDER_STATUS_TONE: Record<string, "neutral" | "info" | "success" | "danger" | "warning"> = { queued: "info", processing: "info", completed: "success", failed: "danger", canceled: "neutral" };
