"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { can, isWorkspaceRole } from "@/lib/auth/permissions";
import {
  ACTIVE_WORKSPACE_COOKIE,
  ForbiddenError,
  getWorkspaceContext,
  requireVerifiedUser,
  requireWorkspacePermission,
} from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { createWorkspaceSchema, fieldErrors, inviteSchema, uuidSchema, workspaceSettingsSchema } from "@/lib/validation";

async function setActiveWorkspace(workspaceId: string) {
  (await cookies()).set(ACTIVE_WORKSPACE_COOKIE, workspaceId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 180,
  });
}

function forbidden(e: unknown): ActionState {
  if (e instanceof ForbiddenError) return { status: "error", message: e.message };
  throw e;
}

export async function createWorkspace(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireVerifiedUser();
  const parsed = createWorkspaceSchema.safeParse({ name: formData.get("name"), slug: formData.get("slug") });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace", { p_name: parsed.data.name, p_slug: parsed.data.slug });
  if (error) {
    const message = dbErrorMessage(error);
    if (error.code === "23505") return { status: "error", fieldErrors: { slug: message } };
    return { status: "error", message };
  }
  await setActiveWorkspace((data as { id: string }).id);
  redirect("/dashboard");
}

export async function switchWorkspace(formData: FormData): Promise<void> {
  const user = await requireVerifiedUser();
  const parsed = uuidSchema.safeParse(formData.get("workspaceId"));
  if (!parsed.success) redirect("/dashboard");
  // Verify membership server-side (RLS-filtered) before honouring the switch.
  const supabase = await createClient();
  const { data } = await supabase
    .from("workspace_members")
    .select("workspace_id")
    .eq("workspace_id", parsed.data)
    .eq("user_id", user.id)
    .maybeSingle();
  if (data) await setActiveWorkspace(parsed.data);
  redirect("/dashboard");
}

export async function updateWorkspaceSettings(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let ctx;
  try {
    ctx = await requireWorkspacePermission("settings.update");
  } catch (e) {
    return forbidden(e);
  }
  const parsed = workspaceSettingsSchema.safeParse({
    name: formData.get("name"),
    timezone: formData.get("timezone"),
    defaultLanguage: formData.get("defaultLanguage"),
    contentNiche: formData.get("contentNiche") ?? "",
    brandVoice: formData.get("brandVoice") ?? "",
    targetAudience: formData.get("targetAudience") ?? "",
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const ws = await supabase.from("workspaces").update({ name: parsed.data.name }).eq("id", ctx.workspace.id).select("id");
  if (ws.error || !ws.data?.length) return { status: "error", message: dbErrorMessage(ws.error, "Could not save workspace.") };

  const st = await supabase
    .from("workspace_settings")
    .update({
      timezone: parsed.data.timezone,
      default_language: parsed.data.defaultLanguage,
      content_niche: parsed.data.contentNiche,
      brand_voice: parsed.data.brandVoice,
      target_audience: parsed.data.targetAudience,
    })
    .eq("workspace_id", ctx.workspace.id)
    .select("workspace_id");
  if (st.error || !st.data?.length) return { status: "error", message: dbErrorMessage(st.error, "Could not save settings.") };

  revalidatePath("/", "layout");
  return { status: "success", message: "Workspace settings saved." };
}

export async function inviteMember(_prev: ActionState, formData: FormData): Promise<ActionState> {
  let ctx;
  try {
    ctx = await requireWorkspacePermission("members.invite");
  } catch (e) {
    return forbidden(e);
  }
  const parsed = inviteSchema.safeParse({ email: formData.get("email"), role: formData.get("role") ?? "member" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  if (parsed.data.role === "admin" && !can(ctx.role, "members.invite_admin")) {
    return { status: "error", fieldErrors: { role: "Only the owner can invite admins." } };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_workspace_invitation", {
    p_workspace_id: ctx.workspace.id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  if (error) return { status: "error", message: dbErrorMessage(error) };
  const row = (Array.isArray(data) ? data[0] : data) as { token: string } | undefined;
  if (!row?.token) return { status: "error", message: "Could not create invitation." };

  revalidatePath("/settings/members");
  return {
    status: "success",
    message:
      "Invitation created. Email delivery is not configured in this phase — copy the link below and send it to your teammate. It is shown only once and expires in 7 days.",
    data: { inviteUrl: `${publicEnv.siteUrl}/invite/${row.token}` },
  };
}

export async function revokeInvitation(formData: FormData): Promise<void> {
  await requireWorkspacePermission("members.invite");
  const id = uuidSchema.parse(formData.get("invitationId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_workspace_invitation", { p_invitation_id: id });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/settings/members");
}

export async function changeMemberRole(formData: FormData): Promise<void> {
  const ctx = await requireWorkspacePermission("members.change_role");
  const userId = uuidSchema.parse(formData.get("userId"));
  const role = formData.get("role");
  if (!isWorkspaceRole(role) || role === "owner") throw new Error("Invalid role");
  const supabase = await createClient();
  const { error } = await supabase.rpc("update_member_role", { p_workspace_id: ctx.workspace.id, p_user_id: userId, p_role: role });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath("/settings/members");
}

export async function removeMember(formData: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const userId = uuidSchema.parse(formData.get("userId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_workspace_member", { p_workspace_id: ctx.workspace.id, p_user_id: userId });
  if (error) throw new Error(dbErrorMessage(error));
  if (userId === ctx.user.id) {
    (await cookies()).delete(ACTIVE_WORKSPACE_COOKIE);
    redirect("/dashboard");
  }
  revalidatePath("/settings/members");
}

export async function acceptInvitation(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requireVerifiedUser();
  const token = String(formData.get("token") ?? "");
  if (!/^[0-9a-f]{64}$/.test(token)) return { status: "error", message: "This invitation link is invalid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_workspace_invitation", { p_token: token });
  if (error) return { status: "error", message: dbErrorMessage(error, "This invitation is invalid or has expired.") };
  await setActiveWorkspace(String(data));
  redirect("/dashboard");
}
