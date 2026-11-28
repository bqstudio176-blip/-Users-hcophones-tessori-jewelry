/**
 * Video Studio upload rules, shared by the browser (fast feedback), server
 * actions and the worker. begin_media_upload() enforces the same mime list
 * and size limit in the database; the worker re-checks magic bytes and probes
 * the file before an asset becomes "ready".
 */
export type MediaKind = "video" | "image" | "audio";

export const MEDIA_TYPES: Record<string, { kind: MediaKind; ext: string; label: string }> = {
  "video/mp4": { kind: "video", ext: "mp4", label: "MP4" },
  "video/quicktime": { kind: "video", ext: "mov", label: "MOV" },
  "video/webm": { kind: "video", ext: "webm", label: "WebM video" },
  "image/jpeg": { kind: "image", ext: "jpg", label: "JPEG" },
  "image/png": { kind: "image", ext: "png", label: "PNG" },
  "image/webp": { kind: "image", ext: "webp", label: "WebP" },
  "audio/mpeg": { kind: "audio", ext: "mp3", label: "MP3" },
  "audio/mp4": { kind: "audio", ext: "m4a", label: "M4A" },
  "audio/x-m4a": { kind: "audio", ext: "m4a", label: "M4A" },
  "audio/wav": { kind: "audio", ext: "wav", label: "WAV" },
  "audio/x-wav": { kind: "audio", ext: "wav", label: "WAV" },
  "audio/webm": { kind: "audio", ext: "webm", label: "WebM audio" },
  "audio/ogg": { kind: "audio", ext: "ogg", label: "Ogg audio" },
};

const EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg",
};

export const MAX_ASSET_BYTES = 1024 ** 3; // 1 GB (decision D3)
export const MAX_ASSET_SECONDS = 600;
export const ACCEPT_ATTR = Object.keys(MEDIA_TYPES).join(",") + ",.mp4,.mov,.webm,.jpg,.jpeg,.png,.webp,.mp3,.m4a,.wav,.ogg";

export type MediaCheck = { ok: true; mime: string; kind: MediaKind } | { ok: false; error: string };

export function classifyUpload(file: { name: string; type: string; size: number }): MediaCheck {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  // Browsers label recordings as e.g. "audio/webm;codecs=opus".
  const baseType = file.type.split(";")[0]!.trim();
  const mime = MEDIA_TYPES[baseType] ? baseType : EXT_TO_MIME[ext];
  if (!mime) return { ok: false, error: "Unsupported file type. Use MP4/MOV/WebM video, JPEG/PNG/WebP images or MP3/M4A/WAV/WebM/Ogg audio." };
  if (!Number.isFinite(file.size) || file.size <= 0) return { ok: false, error: "The file is empty." };
  if (file.size > MAX_ASSET_BYTES) return { ok: false, error: "Files must be 1 GB or smaller." };
  return { ok: true, mime, kind: MEDIA_TYPES[mime]!.kind };
}

/** Identifies a file from its first bytes. Returns the detected container or null. */
export function sniffMedia(bytes: Uint8Array): { kind: MediaKind | "container"; format: string } | null {
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { kind: "image", format: "jpeg" };
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") return { kind: "image", format: "png" };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return { kind: "image", format: "webp" };
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return { kind: "audio", format: "wav" };
  if (bytes.length >= 4 && ascii(0, 4) === "OggS") return { kind: "audio", format: "ogg" };
  if (bytes.length >= 3 && ascii(0, 3) === "ID3") return { kind: "audio", format: "mp3" };
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return { kind: "audio", format: "mp3" };
  // ISO-BMFF (mp4/mov/m4a) and Matroska/WebM can hold video or audio only: ffprobe decides.
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") return { kind: "container", format: ascii(8, 12) === "qt  " ? "mov" : "mp4" };
  if (bytes.length >= 8 && ["moov", "mdat", "wide", "free"].includes(ascii(4, 8))) return { kind: "container", format: "mov" };
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return { kind: "container", format: "webm" };
  return null;
}

/** Whether sniffed bytes are acceptable for the declared kind. */
export function sniffMatchesKind(bytes: Uint8Array, kind: MediaKind): boolean {
  const s = sniffMedia(bytes);
  if (!s) return false;
  if (s.kind === "container") return kind === "video" || kind === "audio";
  return s.kind === kind;
}
