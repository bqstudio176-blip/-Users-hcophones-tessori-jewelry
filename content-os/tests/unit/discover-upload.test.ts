import { describe, expect, it } from "vitest";
import { MAX_UPLOAD_BYTES, sniffVideoContainer, validateUploadMeta } from "@/lib/discover/upload";
import { normalizeTags, sanitizeSearchTerm } from "@/lib/discover/catalog";

const bytes = (s: string, prefix: number[] = [0, 0, 0, 0x20]) => new Uint8Array([...prefix, ...[...s].map((c) => c.charCodeAt(0)), 0, 0, 0, 0]);

describe("validateUploadMeta", () => {
  it("accepts supported videos by MIME or extension", () => {
    expect(validateUploadMeta({ name: "clip.mp4", type: "video/mp4", size: 1000 })).toEqual({ ok: true, mime: "video/mp4" });
    expect(validateUploadMeta({ name: "clip.MOV", type: "", size: 1000 })).toEqual({ ok: true, mime: "video/quicktime" });
    expect(validateUploadMeta({ name: "clip.webm", type: "video/webm", size: 1000 })).toEqual({ ok: true, mime: "video/webm" });
  });
  it("rejects other types, empty and oversized files", () => {
    expect(validateUploadMeta({ name: "x.exe", type: "application/x-msdownload", size: 10 }).ok).toBe(false);
    expect(validateUploadMeta({ name: "x.gif", type: "image/gif", size: 10 }).ok).toBe(false);
    expect(validateUploadMeta({ name: "x.mp4", type: "video/mp4", size: 0 }).ok).toBe(false);
    expect(validateUploadMeta({ name: "x.mp4", type: "video/mp4", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
  });
});

describe("sniffVideoContainer (magic bytes)", () => {
  it("detects MP4, MOV and WebM", () => {
    expect(sniffVideoContainer(bytes("ftypisom"))).toBe("mp4");
    expect(sniffVideoContainer(bytes("ftypqt  "))).toBe("mov");
    expect(sniffVideoContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("webm");
  });
  it("rejects non-video content even with a video extension", () => {
    expect(sniffVideoContainer(new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // PE executable
    expect(sniffVideoContainer(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull(); // PNG
    expect(sniffVideoContainer(new TextEncoder().encode("#!/bin/sh\nrm -rf /"))).toBeNull();
  });
});

describe("tags and search terms", () => {
  it("normalizes tags and reports invalid ones", () => {
    expect(normalizeTags("Hooks, storytelling ,  HOOKS, b-roll, !!!")).toEqual({ tags: ["hooks", "storytelling", "b-roll"], invalid: ["!!!"] });
  });
  it("strips PostgREST filter syntax from search terms", () => {
    expect(sanitizeSearchTerm("hooks),title.eq.x,(%*")).toBe("hooks title.eq.x");
  });
});
