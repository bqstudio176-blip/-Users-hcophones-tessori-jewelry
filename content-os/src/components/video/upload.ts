import { createClient } from "@/lib/supabase/browser";
import { classifyUpload, sniffMatchesKind } from "@/lib/video/media-types";
import { finishAssetUpload, startAssetUpload } from "@/server/actions/video";

async function sha256Hex(file: Blob): Promise<string | null> {
  if (file.size > 100 * 1024 * 1024 || !globalThis.crypto?.subtle) return null; // the worker computes the real checksum anyway
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type UploadPhase = (label: string) => void;

/**
 * Upload flow: validate locally (type, size, magic bytes) → server reserves a
 * private storage path → browser uploads directly (storage RLS) → server
 * verifies the object and queues processing on the worker.
 */
export async function uploadMediaFile(file: File, opts: { title: string; rightsConfirmed: boolean; origin?: "upload" | "recording"; onPhase?: UploadPhase }): Promise<{ ok: true; assetId: string } | { ok: false; error: string }> {
  const check = classifyUpload(file);
  if (!check.ok) return check;
  if (!sniffMatchesKind(new Uint8Array(await file.slice(0, 16).arrayBuffer()), check.kind)) return { ok: false, error: `This file does not look like a valid ${check.kind} file.` };
  opts.onPhase?.("Preparing upload…");
  const start = await startAssetUpload({ name: file.name, type: check.mime, size: file.size, title: opts.title, rightsConfirmed: opts.rightsConfirmed, origin: opts.origin });
  if (!start.ok) return start;
  opts.onPhase?.("Uploading…");
  const { error } = await createClient().storage.from("media").upload(start.path, file, { contentType: start.mime, upsert: false });
  if (error) return { ok: false, error: `Upload failed: ${error.message}` };
  opts.onPhase?.("Verifying…");
  const done = await finishAssetUpload(start.assetId, await sha256Hex(file));
  if (!done.ok) return done;
  return { ok: true, assetId: start.assetId };
}
