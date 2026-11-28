import { describe, expect, it } from "vitest";
import { parseReferenceUrl } from "@/lib/discover/url";

describe("parseReferenceUrl — Instagram", () => {
  it.each([
    ["https://www.instagram.com/reel/C1a2B3c4D5/", "instagram_reel", "C1a2B3c4D5"],
    ["https://instagram.com/reels/C1a2B3c4D5?igsh=abc", "instagram_reel", "C1a2B3c4D5"],
    ["https://www.instagram.com/someuser/reel/C1a2B3c4D5/", "instagram_reel", "C1a2B3c4D5"],
    ["https://www.instagram.com/p/C1a2B3c4D5/", "instagram_post", "C1a2B3c4D5"],
  ])("accepts %s", (url, kind, code) => {
    const r = parseReferenceUrl(url);
    expect(r).toMatchObject({ ok: true, sourceType: "instagram", kind, externalId: code, normalized: `instagram:${code}` });
  });

  it("canonicalises so different spellings are detected as duplicates", () => {
    const a = parseReferenceUrl("https://instagram.com/reels/ABCDE12345?igsh=x");
    const b = parseReferenceUrl("https://www.instagram.com/reel/ABCDE12345/");
    expect(a.ok && b.ok && a.normalized === b.normalized && a.canonicalUrl === b.canonicalUrl).toBe(true);
  });

  it("rejects profile pages and malformed codes", () => {
    expect(parseReferenceUrl("https://www.instagram.com/someuser/").ok).toBe(false);
    expect(parseReferenceUrl("https://www.instagram.com/reel/a/").ok).toBe(false);
  });
});

describe("parseReferenceUrl — YouTube", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10", "youtube_video"],
    ["https://youtu.be/dQw4w9WgXcQ", "youtube_video"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "youtube_short"],
    ["https://m.youtube.com/watch?v=dQw4w9WgXcQ", "youtube_video"],
  ])("accepts %s", (url, kind) => {
    expect(parseReferenceUrl(url)).toMatchObject({ ok: true, sourceType: "youtube", kind, normalized: "youtube:dQw4w9WgXcQ" });
  });
  it("rejects channel pages and bad ids", () => {
    expect(parseReferenceUrl("https://www.youtube.com/@channel").ok).toBe(false);
    expect(parseReferenceUrl("https://www.youtube.com/watch?v=short").ok).toBe(false);
  });
});

describe("parseReferenceUrl — SSRF and input safety", () => {
  it.each([
    "http://www.instagram.com/reel/ABCDE12345/",
    "https://127.0.0.1/video.mp4",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "https://localhost/x",
    "https://metadata.google.internal/x",
    "https://user:pass@example.com/x",
    "https://example.com:8443/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "",
  ])("rejects %j", (url) => {
    expect(parseReferenceUrl(url).ok).toBe(false);
  });

  it("keeps other https sites as links, stripping tracking params", () => {
    const r = parseReferenceUrl("https://Example.com/blog/post/?utm_source=x&id=7#top");
    expect(r).toMatchObject({ ok: true, sourceType: "web", normalized: "web:example.com/blog/post?id=7", canonicalUrl: "https://example.com/blog/post?id=7" });
  });
});
