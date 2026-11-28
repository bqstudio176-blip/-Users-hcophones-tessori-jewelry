import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Short-lived signed URLs for private media, minted with the USER's client so
 * storage RLS (workspace membership) is enforced. Returns {} on any failure.
 */
export async function signMediaUrls(paths: (string | null | undefined)[], expiresInSeconds = 3600): Promise<Record<string, string>> {
  const unique = [...new Set(paths.filter((p): p is string => Boolean(p)))];
  if (unique.length === 0) return {};
  const supabase = await createClient();
  const { data, error } = await supabase.storage.from("media").createSignedUrls(unique, expiresInSeconds);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const item of data) if (item.path && item.signedUrl && !item.error) out[item.path] = item.signedUrl;
  return out;
}
