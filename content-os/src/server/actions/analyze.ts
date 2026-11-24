"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getWorkspaceContext } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";

export async function requestAnalysis(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const ref = uuidSchema.safeParse(fd.get("referenceId"));
  const key = z.string().regex(/^[A-Za-z0-9-]{8,64}$/).safeParse(fd.get("idempotencyKey"));
  if (!ref.success) return { status: "error", message: "Invalid reference." };
  const supabase = await createClient();
  // request_analysis() checks membership, the uploaded video, one active
  // analysis per reference and charges credits atomically.
  const { data, error } = await supabase.rpc("request_analysis", {
    p_reference_id: ref.data,
    p_idempotency_key: key.success ? key.data : null,
  });
  if (error || !data) return { status: "error", message: dbErrorMessage(error, "Could not start the analysis.") };
  revalidatePath("/analyze");
  redirect(`/analyze/${data}`);
}

export async function cancelAnalysis(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("analysisId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_analysis", { p_analysis_id: id });
  if (error) throw new Error(dbErrorMessage(error));
  revalidatePath(`/analyze/${id}`);
}

export async function updateReportNotes(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("analysisId"));
  const notes = z.string().max(10000).safeParse(fd.get("notes") ?? "");
  if (!id.success) return { status: "error", message: "Invalid analysis." };
  if (!notes.success) return { status: "error", fieldErrors: { notes: "Use at most 10,000 characters" } };
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("analysis_reports")
    .update({ user_notes: notes.data.trim() || null })
    .eq("analysis_id", id.data)
    .select("id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save notes.") };
  revalidatePath(`/analyze/${id.data}`);
  return { status: "success", message: "Notes saved." };
}
