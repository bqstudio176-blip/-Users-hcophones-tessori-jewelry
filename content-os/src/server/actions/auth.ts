"use server";

import { redirect } from "next/navigation";
import { safeNextPath } from "@/lib/auth/route-access";
import { publicEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import {
  fieldErrors,
  forgotPasswordSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
} from "@/lib/validation";

const confirmUrl = (next: string) => `${publicEnv.siteUrl}/auth/confirm?next=${encodeURIComponent(next)}`;

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: confirmUrl("/onboarding"),
    },
  });

  if (error) {
    // Weak-password and rate-limit errors are safe to surface; others are generic.
    if (error.code === "weak_password") return { status: "error", fieldErrors: { password: error.message } };
    if (error.status === 429) return { status: "error", message: "Too many attempts. Please wait and try again." };
    return { status: "error", message: "We could not create your account. Please try again." };
  }

  // If email confirmation is disabled in Supabase, a session is returned immediately.
  if (data.session) redirect("/onboarding");
  // Same response whether or not the email already exists (no account enumeration).
  redirect(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
}

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = signInSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    if (error.code === "email_not_confirmed") {
      redirect(`/verify-email?email=${encodeURIComponent(parsed.data.email)}`);
    }
    if (error.status === 429) return { status: "error", message: "Too many attempts. Please wait and try again." };
    return { status: "error", message: "Invalid email or password." };
  }
  redirect(safeNextPath(formData.get("next")?.toString()));
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export async function requestPasswordReset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: confirmUrl("/reset-password"),
  });
  if (error?.status === 429) return { status: "error", message: "Too many requests. Please wait and try again." };
  // Always the same message (no account enumeration).
  return {
    status: "success",
    message: "If an account exists for that email, a reset link is on its way.",
  };
}

export async function resetPassword(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = resetPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };

  const supabase = await createClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    return { status: "error", message: "Your reset link has expired. Request a new one." };
  }
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    if (error.code === "same_password") return { status: "error", fieldErrors: { password: "Choose a different password." } };
    if (error.code === "weak_password") return { status: "error", fieldErrors: { password: error.message } };
    return { status: "error", message: "We could not update your password. Request a new link." };
  }
  redirect("/dashboard");
}

export async function resendVerification(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = forgotPasswordSchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { error } = await supabase.auth.resend({
    type: "signup",
    email: parsed.data.email,
    options: { emailRedirectTo: confirmUrl("/onboarding") },
  });
  if (error?.status === 429) return { status: "error", message: "Please wait a minute before requesting another email." };
  return { status: "success", message: "If that account is awaiting verification, we sent a new link." };
}
