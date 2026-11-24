import { NextResponse, type NextRequest } from "next/server";
import { can, isWorkspaceRole } from "@/lib/auth/permissions";
import { requireVerifiedUser } from "@/lib/auth/session";
import { encryptToken } from "@/lib/crypto/token-vault";
import { publicEnv, serverEnv } from "@/lib/env";
import { exchangeCodeForConnection, IG_NONCE_COOKIE, verifyOAuthState } from "@/lib/integrations/instagram";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

function done(status: "connected" | "error", code?: string) {
  const url = new URL("/settings/connections", publicEnv.siteUrl);
  url.searchParams.set(status === "connected" ? "connected" : "error", code ?? "instagram");
  const res = NextResponse.redirect(url);
  res.cookies.set(IG_NONCE_COOKIE, "", { path: "/api/connections/instagram", maxAge: 0 });
  return res;
}

export async function GET(request: NextRequest) {
  const user = await requireVerifiedUser();
  const params = request.nextUrl.searchParams;

  if (params.get("error")) return done("error", "denied");

  let payload;
  try {
    payload = verifyOAuthState(params.get("state"), {
      secret: serverEnv.oauthStateSecret,
      nonceCookie: request.cookies.get(IG_NONCE_COOKIE)?.value,
      userId: user.id,
    });
  } catch {
    return done("error", "invalid_state");
  }

  // Re-verify authorization for the workspace named in the (signed) state,
  // using the user's own RLS-scoped client.
  const supabase = await createClient();
  const { data: membership } = await supabase
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", payload.workspaceId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!membership || !isWorkspaceRole(membership.role) || !can(membership.role, "social.manage")) {
    return done("error", "forbidden");
  }

  const code = params.get("code");
  const ig = serverEnv.instagram;
  if (!code || !ig.configured || !ig.appId || !ig.appSecret) return done("error", "not_configured");

  let connection;
  try {
    connection = await exchangeCodeForConnection({
      code,
      appId: ig.appId,
      appSecret: ig.appSecret,
      redirectUri: `${publicEnv.siteUrl}/api/connections/instagram/callback`,
    });
  } catch (err) {
    console.error("[instagram] exchange failed:", err instanceof Error ? err.message : "unknown");
    return done("error", "exchange_failed");
  }

  const version = serverEnv.tokenEncryptionCurrentVersion;
  let encrypted: string;
  try {
    encrypted = encryptToken(connection.accessToken, {
      resolve: (v) => serverEnv.tokenEncryptionKey(v),
      version,
      aad: payload.workspaceId,
    });
  } catch (err) {
    console.error("[instagram] encryption unavailable:", err instanceof Error ? err.message : "unknown");
    return done("error", "not_configured");
  }

  // Service role is required to write the credentials table (no client access).
  // Authorization was verified above.
  const admin = createAdminClient();
  const { data: account, error: accountError } = await admin
    .from("social_accounts")
    .insert({
      workspace_id: payload.workspaceId,
      platform: "instagram",
      status: "connected",
      external_account_id: connection.externalAccountId,
      username: connection.username,
      display_name: connection.displayName,
      profile_picture_url: connection.profilePictureUrl,
      account_type: connection.accountType,
      scopes: connection.scopes,
      connected_by: user.id,
      connected_at: new Date().toISOString(),
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (accountError || !account) {
    return done("error", accountError?.code === "23505" ? "already_connected" : "save_failed");
  }

  const { error: credError } = await admin.from("social_account_credentials").insert({
    social_account_id: account.id,
    workspace_id: payload.workspaceId,
    encrypted_access_token: encrypted,
    token_expires_at: connection.expiresAt?.toISOString() ?? null,
    key_version: version,
  });
  if (credError) {
    await admin.from("social_accounts").delete().eq("id", account.id);
    return done("error", "save_failed");
  }

  return done("connected");
}
