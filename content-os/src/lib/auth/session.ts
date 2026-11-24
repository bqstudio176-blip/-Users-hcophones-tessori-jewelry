import "server-only";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";
import { can, type WorkspaceAction } from "@/lib/auth/permissions";
import { createClient } from "@/lib/supabase/server";
import type { Membership, Profile } from "@/lib/types";

export const ACTIVE_WORKSPACE_COOKIE = "cos_ws";
export const THEME_COOKIE = "cos_theme";

/**
 * Authoritative user lookup: getUser() round-trips to Supabase Auth so a
 * revoked/forged session cookie is rejected. Memoised per request.
 */
export const getSessionUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});

export async function requireUser() {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  return user;
}

export async function requireVerifiedUser() {
  const user = await requireUser();
  if (!user.email_confirmed_at) redirect("/verify-email");
  return user;
}

export const getProfile = cache(async (userId: string): Promise<Profile | null> => {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, email, full_name, avatar_url, preferences, is_platform_admin, created_at")
    .eq("id", userId)
    .maybeSingle();
  return (data as Profile | null) ?? null;
});

export const getMemberships = cache(async (userId: string): Promise<Membership[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspace_members")
    .select("role, workspace:workspaces!inner(id, name, slug, owner_id, created_at)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`Could not load workspaces: ${error.message}`);
  return (data ?? []) as unknown as Membership[];
});

/**
 * Resolves the signed-in user, their profile, memberships and the ACTIVE
 * workspace. The active workspace comes from a cookie but is only honoured if
 * the user is actually a member (checked against RLS-filtered data), so a
 * tampered cookie cannot grant access to another tenant.
 */
export const getWorkspaceContext = cache(async () => {
  const user = await requireVerifiedUser();
  const [profile, memberships] = await Promise.all([getProfile(user.id), getMemberships(user.id)]);
  if (!profile) throw new Error("Profile not found for signed-in user");
  if (memberships.length === 0) redirect("/onboarding");

  const cookieStore = await cookies();
  const preferred = cookieStore.get(ACTIVE_WORKSPACE_COOKIE)?.value;
  const active = memberships.find((m) => m.workspace.id === preferred) ?? memberships[0]!;

  return {
    user,
    profile,
    memberships,
    workspace: active.workspace,
    role: active.role,
  };
});

export type WorkspaceContext = Awaited<ReturnType<typeof getWorkspaceContext>>;

export class ForbiddenError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/** Throws ForbiddenError when the active role lacks `action`. */
export async function requireWorkspacePermission(action: WorkspaceAction) {
  const ctx = await getWorkspaceContext();
  if (!can(ctx.role, action)) throw new ForbiddenError();
  return ctx;
}

/**
 * Platform admin gate. Responds 404 (not 403) so the admin surface is not
 * discoverable. Data access is additionally restricted by RLS policies that
 * call public.is_platform_admin().
 */
export async function requirePlatformAdmin() {
  const user = await requireVerifiedUser();
  const profile = await getProfile(user.id);
  if (!profile?.is_platform_admin) notFound();
  return { user, profile };
}
