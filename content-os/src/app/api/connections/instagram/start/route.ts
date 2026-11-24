import { NextResponse } from "next/server";
import { can } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { publicEnv, serverEnv } from "@/lib/env";
import { buildAuthorizeUrl, createOAuthState, IG_NONCE_COOKIE } from "@/lib/integrations/instagram";
import { createClient } from "@/lib/supabase/server";


const back = (code: string) => new URL(`/settings/connections?error=${code}`, publicEnv.siteUrl);

export async function GET() {
  const ctx = await getWorkspaceContext();
  if (!can(ctx.role, "social.manage")) return NextResponse.redirect(back("forbidden"));

  const ig = serverEnv.instagram;
  if (!ig.configured || !ig.appId) return NextResponse.redirect(back("not_configured"));

  // One connection per workspace (also enforced by a DB unique constraint).
  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("social_accounts")
    .select("id")
    .eq("workspace_id", ctx.workspace.id)
    .maybeSingle();
  if (existing) return NextResponse.redirect(back("already_connected"));

  const { state, nonce } = createOAuthState({ workspaceId: ctx.workspace.id, userId: ctx.user.id }, serverEnv.oauthStateSecret);
  const response = NextResponse.redirect(
    buildAuthorizeUrl({
      appId: ig.appId,
      redirectUri: `${publicEnv.siteUrl}/api/connections/instagram/callback`,
      state,
    }),
  );
  response.cookies.set(IG_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/connections/instagram",
    maxAge: 600,
  });
  return response;
}
