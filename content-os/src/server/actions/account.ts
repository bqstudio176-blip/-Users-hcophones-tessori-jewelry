"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getProfile, requireVerifiedUser, THEME_COOKIE } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { changePasswordSchema, fieldErrors, parsePreferences, preferencesSchema, profileSchema } from "@/lib/validation";


export async function updateProfile(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireVerifiedUser();
  const parsed = profileSchema.safeParse({ fullName: formData.get("fullName"), avatarUrl: formData.get("avatarUrl") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .update({ full_name: parsed.data.fullName, avatar_url: parsed.data.avatarUrl })
    .eq("id", user.id)
    .select("id");
  if (error || !data?.length) return { status: "error", message: "Could not save your profile." };
  revalidatePath("/", "layout");
  return { status: "success", message: "Profile saved." };
}

export async function updatePreferences(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireVerifiedUser();
  const parsed = preferencesSchema.safeParse({
    theme: formData.get("theme"),
    emailProductUpdates: formData.get("emailProductUpdates") === "on",
    emailWeeklySummary: formData.get("emailWeeklySummary") === "on",
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const profile = await getProfile(user.id);
  const merged = { ...(profile?.preferences ?? {}), ...parsePreferences(parsed.data) };

  const supabase = await createClient();
  const { data, error } = await supabase.from("profiles").update({ preferences: merged }).eq("id", user.id).select("id");
  if (error || !data?.length) return { status: "error", message: "Could not save preferences." };

  (await cookies()).set(THEME_COOKIE, parsed.data.theme, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/", "layout");
  return { status: "success", message: "Preferences saved." };
}

export async function changePassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const user = await requireVerifiedUser();
  const parsed = changePasswordSchema.safeParse({
    currentPassword: formData.get("currentPassword"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  // Re-authenticate: Supabase's updateUser does not require the old password.
  const { error: reauthError } = await supabase.auth.signInWithPassword({
    email: user.email ?? "",
    password: parsed.data.currentPassword,
  });
  if (reauthError) return { status: "error", fieldErrors: { currentPassword: "Current password is incorrect." } };

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "weak_password") return { status: "error", fieldErrors: { password: error.message } };
    return { status: "error", message: "Could not update your password." };
  }
  return { status: "success", message: "Password updated." };
}

/** Revokes every refresh token for this user (all devices), then signs out here. */
export async function signOutEverywhere(): Promise<void> {
  await requireVerifiedUser();
  const supabase = await createClient();
  await supabase.auth.signOut({ scope: "global" });
  redirect("/login");
}
