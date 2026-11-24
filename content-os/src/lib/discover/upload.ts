/**
 * Upload validation shared by the browser (fast feedback), server actions and
 * the database (begin_reference_upload enforces the same limits). The worker
 * additionally verifies the real container with ffprobe before processing.
 */
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // keep in sync with migration 0600/0800
export const MAX_VIDEO_SECONDS = 10 * 60;

export const ALLOWED_VIDEO_TYPES: Record<string, { ext: string; label: string }> = {
  "video/mp4": { ext: "mp4", label: "MP4" },
  "video/quicktime": { ext: "mov", label: "MOV" },
  "video/webm": { ext: "webm", label: "WebM" },
};

const EXT_TO_MIME: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm" };

export type UploadCheck = { ok: true; mime: string } | { ok: false; error: string };

export function validateUploadMeta(file: { name: string; type: string; size: number }): UploadCheck {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const mime = ALLOWED_VIDEO_TYPES[file.type] ? file.type : EXT_TO_MIME[ext];
  if (!mime) return { ok: false, error: "Unsupported file type. Upload an MP4, MOV or WebM video." };
  if (file.type && file.type !== mime && ALLOWED_VIDEO_TYPES[file.type] === undefined && file.type !== "application/octet-stream") {
    return { ok: false, error: "The file type does not match its extension." };
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: "The file is empty." };
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: "The file is larger than 200 MB." };
  return { ok: true, mime };
}

/**
 * Identifies the container from its first bytes ("magic numbers"). Prevents a
 * renamed executable or image from being treated as a video. Returns null when
 * the bytes are not a supported video container.
 */
export function sniffVideoContainer(bytes: Uint8Array): "mp4" | "mov" | "webm" | null {
  if (bytes.length >= 12) {
    const box = String.fromCharCode(bytes[4]!, bytes[5]!, bytes[6]!, bytes[7]!);
    if (box === "ftyp") {
      const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
      return brand === "qt  " ? "mov" : "mp4";
    }
    if (["moov", "mdat", "wide", "free"].includes(box)) return "mov";
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return "webm";
  return null;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
