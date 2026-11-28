"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getWorkspaceContext } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { uuidSchema } from "@/lib/validation";
import { classifyUpload } from "@/lib/video/media-types";
import { buildInitialTimeline, mergeScriptUpdate, Timeline, timelineAssetIds, validateTimeline, type AssetInfo, type ScriptSnapshotScene } from "@/server/video/timeline";

type Result<T extends object = object> = ({ ok: true } & T) | { ok: false; error: string; conflict?: boolean };

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------
export async function startAssetUpload(input: { name: string; type: string; size: number; title: string; rightsConfirmed: boolean; origin?: "upload" | "recording" }): Promise<Result<{ assetId: string; path: string; mime: string }>> {
  const ctx = await getWorkspaceContext();
  const check = classifyUpload(input);
  if (!check.ok) return { ok: false, error: check.error };
  if (!input.rightsConfirmed) return { ok: false, error: "Confirm that you own this file or have the rights to use it." };
  const title = String(input.title ?? "").trim().slice(0, 200) || input.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Untitled";
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("begin_media_upload", {
    p_workspace_id: ctx.workspace.id, p_kind: check.kind, p_mime: check.mime, p_size_bytes: input.size, p_title: title,
    p_rights_confirmed: true, p_origin: input.origin === "recording" ? "recording" : "upload",
  });
  if (error || !data) return { ok: false, error: dbErrorMessage(error, "Could not start the upload.") };
  const r = data as { asset_id: string; path: string };
  return { ok: true, assetId: r.asset_id, path: r.path, mime: check.mime };
}

export async function finishAssetUpload(assetId: string, sha256: string | null): Promise<Result> {
  await getWorkspaceContext();
  if (!uuidSchema.safeParse(assetId).success) return { ok: false, error: "Invalid asset." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_media_upload", { p_asset_id: assetId, p_sha256: sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null });
  if (error) return { ok: false, error: dbErrorMessage(error, "Could not finish the upload.") };
  revalidatePath("/video-studio", "layout");
  return { ok: true };
}

export async function updateAsset(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const parsed = z.object({
    id: uuidSchema,
    title: z.string().trim().min(1, "Give the file a name").max(200),
    tags: z.string().max(300).transform((v) => [...new Set(v.split(",").map((t) => t.trim().toLowerCase()).filter((t) => /^[a-z0-9][a-z0-9-]{0,29}$/.test(t)))].slice(0, 12)),
  }).safeParse({ id: fd.get("id"), title: fd.get("title") ?? "", tags: fd.get("tags") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: { title: parsed.error.issues[0]?.message ?? "Invalid" } };
  const supabase = await createClient();
  const { error } = await supabase.from("media_assets").update({ title: parsed.data.title, tags: parsed.data.tags }).eq("id", parsed.data.id);
  if (error) return { status: "error", message: dbErrorMessage(error) };
  revalidatePath("/video-studio/media", "layout");
  return { status: "success", message: "Saved." };
}

export async function deleteAsset(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const supabase = await createClient();
  const { data: asset } = await supabase.from("media_assets").select("storage_path, proxy_path, thumbnail_path").eq("id", id).maybeSingle();
  const { data, error } = await supabase.from("media_assets").delete().eq("id", id).select("id");
  if (error || !data?.length) redirect(`/video-studio/media/${id}?error=${encodeURIComponent("This file is used by a video or voiceover take and cannot be deleted.")}`);
  // The rows are gone, so storage RLS now allows removing the orphaned objects.
  const paths = [asset?.storage_path, asset?.proxy_path, asset?.thumbnail_path].filter((p): p is string => Boolean(p));
  if (paths.length) await supabase.storage.from("media").remove(paths);
  revalidatePath("/video-studio", "layout");
  redirect("/video-studio/media?deleted=1");
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------
export async function createVideoFromScript(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const parsed = z.object({
    scriptId: uuidSchema,
    format: z.enum(["vertical", "square", "portrait"]),
    title: z.string().trim().max(200),
  }).safeParse({ scriptId: fd.get("scriptId"), format: fd.get("format") ?? "vertical", title: fd.get("title") ?? "" });
  if (!parsed.success) return { status: "error", fieldErrors: { scriptId: "Choose a script" } };
  const supabase = await createClient();
  const { data: scenes, error: e1 } = await supabase.from("script_scenes")
    .select("id, position, scene_title, estimated_duration_seconds, spoken_text, on_screen_text").eq("script_id", parsed.data.scriptId).order("position");
  if (e1) return { status: "error", message: dbErrorMessage(e1) };
  const timeline = buildInitialTimeline((scenes ?? []) as ScriptSnapshotScene[], parsed.data.format);
  const { data, error } = await supabase.rpc("create_video_project", { p_script_id: parsed.data.scriptId, p_title: parsed.data.title || null, p_format: parsed.data.format, p_timeline: timeline });
  if (error || !data) return { status: "error", message: dbErrorMessage(error, "Could not create the video.") };
  revalidatePath("/video-studio");
  redirect(`/video-studio/${data}?created=1`);
}

async function assetMap(ids: string[]): Promise<Map<string, AssetInfo>> {
  if (!ids.length) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.from("media_assets").select("id, kind, status, duration_seconds, has_audio").in("id", ids);
  return new Map((data ?? []).map((a) => [a.id, { ...a, duration_seconds: a.duration_seconds === null ? null : Number(a.duration_seconds) } as AssetInfo]));
}

/** Saves the editor's timeline. Optimistic concurrency: a stale version is reported, never overwritten. */
export async function saveTimeline(projectId: string, timeline: unknown, expectedVersion: number, snapshot = false, note = ""): Promise<Result<{ version: number }>> {
  await getWorkspaceContext();
  if (!uuidSchema.safeParse(projectId).success) return { ok: false, error: "Invalid video." };
  const parsed = Timeline.safeParse(timeline);
  if (!parsed.success) return { ok: false, error: `The timeline is invalid: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
  const problems = validateTimeline(parsed.data, await assetMap(timelineAssetIds(parsed.data)));
  if (problems.length) return { ok: false, error: problems.slice(0, 3).join(" · ") };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("save_video_timeline", { p_project_id: projectId, p_timeline: parsed.data, p_expected_version: expectedVersion, p_snapshot: snapshot, p_note: note.slice(0, 500) || null });
  if (error) {
    if (error.code === "40001") return { ok: false, conflict: true, error: "Someone saved this video after you opened it. Reload to get the latest version — your unsaved changes are still on screen." };
    return { ok: false, error: dbErrorMessage(error, "Could not save.") };
  }
  revalidatePath(`/video-studio/${projectId}`, "layout");
  return { ok: true, version: data as number };
}

export async function renameVideo(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("id"));
  const title = String(fd.get("title") ?? "").trim();
  if (!id.success || !title || title.length > 200) return { status: "error", fieldErrors: { title: "1–200 characters" } };
  const supabase = await createClient();
  const { error } = await supabase.from("video_projects").update({ title }).eq("id", id.data);
  if (error) return { status: "error", message: dbErrorMessage(error) };
  revalidatePath("/video-studio", "layout");
  return { status: "success", message: "Renamed." };
}

export async function setArchived(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const supabase = await createClient();
  await supabase.rpc("set_video_project_archived", { p_project_id: id, p_archived: fd.get("archived") === "true" });
  revalidatePath("/video-studio", "layout");
}

export async function deleteVideo(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const supabase = await createClient();
  const { data: renders } = await supabase.from("video_renders").select("output_path, srt_path").eq("project_id", id);
  const { data, error } = await supabase.from("video_projects").delete().eq("id", id).select("id");
  if (error || !data?.length) redirect(`/video-studio/${id}/renders?error=${encodeURIComponent("Only the creator or an owner/admin can delete this video, and not while a render is running.")}`);
  const paths = (renders ?? []).flatMap((r) => [r.output_path, r.srt_path]).filter((p): p is string => Boolean(p));
  if (paths.length) await supabase.storage.from("media").remove(paths);
  revalidatePath("/video-studio");
  redirect("/video-studio?deleted=1");
}

export async function restoreTimelineVersion(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const versionId = uuidSchema.parse(fd.get("versionId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_video_timeline", { p_project_id: id, p_version_id: versionId });
  if (error) redirect(`/video-studio/${id}/versions?error=${encodeURIComponent(dbErrorMessage(error))}`);
  revalidatePath(`/video-studio/${id}`, "layout");
  redirect(`/video-studio/${id}?restored=1`);
}

/** Applies the newer script after the user reviewed the diff. */
export async function applyScriptUpdate(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const expected = z.coerce.number().int().min(1).parse(fd.get("version"));
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("timeline, script_id, script_snapshot").eq("id", id).maybeSingle();
  if (!p?.script_id) redirect(`/video-studio/${id}/script?error=${encodeURIComponent("The source script no longer exists.")}`);
  const { data: scenes } = await supabase.from("script_scenes").select("id, position, scene_title, estimated_duration_seconds, spoken_text, on_screen_text").eq("script_id", p.script_id).order("position");
  const current = Timeline.parse(p.timeline);
  const { timeline } = mergeScriptUpdate(current, ((p.script_snapshot as { scenes?: ScriptSnapshotScene[] })?.scenes ?? []), (scenes ?? []) as ScriptSnapshotScene[]);
  const { error } = await supabase.rpc("update_video_from_script", { p_project_id: id, p_timeline: timeline, p_expected_version: expected });
  if (error) redirect(`/video-studio/${id}/script?error=${encodeURIComponent(error.code === "40001" ? "The video changed while you were reviewing. Review the changes again." : dbErrorMessage(error))}`);
  revalidatePath(`/video-studio/${id}`, "layout");
  redirect(`/video-studio/${id}?script_updated=1`);
}

// ---------------------------------------------------------------------------
// Voiceover
// ---------------------------------------------------------------------------
export async function addVoiceoverTake(projectId: string, assetId: string, sceneKey: string | null): Promise<Result<{ takeId: string }>> {
  await getWorkspaceContext();
  if (!uuidSchema.safeParse(projectId).success || !uuidSchema.safeParse(assetId).success) return { ok: false, error: "Invalid request." };
  if (sceneKey !== null && !/^[a-z0-9_-]{1,40}$/.test(sceneKey)) return { ok: false, error: "Invalid scene." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("add_voiceover_take", { p_project_id: projectId, p_asset_id: assetId, p_scene_key: sceneKey });
  if (error || !data) return { ok: false, error: dbErrorMessage(error, "Could not add the take.") };
  revalidatePath(`/video-studio/${projectId}`, "layout");
  return { ok: true, takeId: data as string };
}

/** Puts a take into the timeline (whole video or its scene). Durations and captions stay as they are until the user asks. */
export async function applyTake(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const takeId = uuidSchema.parse(fd.get("takeId"));
  const supabase = await createClient();
  const [{ data: p }, { data: take }] = await Promise.all([
    supabase.from("video_projects").select("timeline, timeline_version").eq("id", id).maybeSingle(),
    supabase.from("voiceover_takes").select("id, asset_id, scene_key, project_id, media_assets(status)").eq("id", takeId).maybeSingle(),
  ]);
  const fail = (m: string) => redirect(`/video-studio/${id}/voiceover?error=${encodeURIComponent(m)}`);
  if (!p || !take || take.project_id !== id) fail("Take not found.");
  const asset = (Array.isArray(take!.media_assets) ? take!.media_assets[0] : take!.media_assets) as { status: string } | null;
  if (asset?.status !== "ready") fail("The recording is still processing. Try again in a moment.");
  const t = Timeline.parse(p!.timeline);
  if (take!.scene_key) {
    const scene = t.scenes.find((s) => s.id === take!.scene_key);
    if (!scene) fail("That scene is no longer in the timeline.");
    t.voiceover = null;
    scene!.voice = { asset_id: take!.asset_id, take_id: take!.id, volume: 1 };
  } else {
    t.scenes = t.scenes.map((s) => ({ ...s, voice: null }));
    t.voiceover = { asset_id: take!.asset_id, take_id: take!.id, volume: 1, offset: 0 };
  }
  const { error } = await supabase.rpc("save_video_timeline", { p_project_id: id, p_timeline: t, p_expected_version: p!.timeline_version, p_snapshot: true, p_note: "Voiceover take applied" });
  if (error) fail(dbErrorMessage(error));
  revalidatePath(`/video-studio/${id}`, "layout");
  redirect(`/video-studio/${id}?voiceover=1`);
}

export async function deleteTake(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const takeId = uuidSchema.parse(fd.get("takeId"));
  const supabase = await createClient();
  const { data } = await supabase.from("voiceover_takes").delete().eq("id", takeId).select("id");
  if (!data?.length) redirect(`/video-studio/${id}/voiceover?error=${encodeURIComponent("This take is used in the timeline. Remove it there first.")}`);
  revalidatePath(`/video-studio/${id}/voiceover`);
}

// ---------------------------------------------------------------------------
// Renders
// ---------------------------------------------------------------------------
export async function requestRender(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const parsed = z.object({ id: uuidSchema, kind: z.enum(["draft", "final"]), key: z.string().regex(/^[0-9a-f-]{36}$/) })
    .safeParse({ id: fd.get("id"), kind: fd.get("kind"), key: fd.get("key") ?? randomUUID() });
  if (!parsed.success) return { status: "error", message: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_render", { p_project_id: parsed.data.id, p_kind: parsed.data.kind, p_idempotency_key: `render:${parsed.data.key}` });
  if (error) return { status: "error", message: dbErrorMessage(error, "Could not start the render.") };
  revalidatePath(`/video-studio/${parsed.data.id}`, "layout");
  redirect(`/video-studio/${parsed.data.id}/renders?queued=${parsed.data.kind}`);
}

export async function cancelRender(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const renderId = uuidSchema.parse(fd.get("renderId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_render", { p_render_id: renderId });
  if (error) redirect(`/video-studio/${id}/renders?error=${encodeURIComponent(dbErrorMessage(error))}`);
  revalidatePath(`/video-studio/${id}`, "layout");
}

export async function markReady(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("id"));
  const renderId = uuidSchema.parse(fd.get("renderId"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_video_ready", { p_project_id: id, p_render_id: renderId });
  if (error) redirect(`/video-studio/${id}/renders?error=${encodeURIComponent(dbErrorMessage(error))}`);
  revalidatePath("/video-studio", "layout");
  redirect(`/video-studio/${id}/renders?ready=1`);
}
