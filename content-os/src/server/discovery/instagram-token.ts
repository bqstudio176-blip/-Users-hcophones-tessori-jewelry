import "server-only";
import { decryptToken } from "@/lib/crypto/token-vault";
import { serverEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Returns the decrypted Instagram token for a workspace, or null.
 * CALLER MUST have verified the user is a member of `workspaceId`.
 * Uses the service role because credentials have no client access.
 */
export async function getWorkspaceInstagramToken(workspaceId: string): Promise<string | null> {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const admin = createAdminClient();
  const { data } = await admin
    .from("social_account_credentials")
    .select("encrypted_access_token, token_expires_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) return null;
  if (data.token_expires_at && new Date(data.token_expires_at) < new Date()) return null;
  try {
    return decryptToken(data.encrypted_access_token, { resolve: (v) => serverEnv.tokenEncryptionKey(v), aad: workspaceId });
  } catch {
    return null;
  }
}
