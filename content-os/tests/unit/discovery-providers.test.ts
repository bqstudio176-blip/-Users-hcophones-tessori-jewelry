import { describe, expect, it, vi } from "vitest";
import { applyLibraryFilters, parseLibraryParams, type FilterBuilder } from "@/server/discovery/library";
import { instagramHashtagProvider, instagramOwnMediaProvider } from "@/server/discovery/providers/instagram";
import { youtubeProvider } from "@/server/discovery/providers/youtube";
import { DISCOVERY_PROVIDERS, runDiscovery } from "@/server/discovery/registry";
import { matchesFormat, parseIsoDuration, type DiscoveryQuery } from "@/server/discovery/types";
import { checkReferenceUrl } from "@/server/discovery/url-check";
import { parseReferenceUrl } from "@/lib/discover/url";

// NOTE: every external provider below runs against MOCKED HTTP. These are not live integration tests.
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const q: DiscoveryQuery = { keywords: "morning routine", niche: "fitness", format: "short", limit: 10 };

describe("provider registry", () => {
  it("documents every provider", () => {
    for (const p of DISCOVERY_PROVIDERS) {
      expect(p.docs.capabilities.length, p.id).toBeGreaterThan(0);
      for (const k of ["authentication", "rateLimits", "restrictions", "costs"] as const) expect(p.docs[k].trim().length, `${p.id}.${k}`).toBeGreaterThan(3);
    }
  });

  it("isolates failures: one provider erroring does not break the others", async () => {
    const runs = await runDiscovery(["library", "youtube", "instagram_hashtag"], q, {
      workspaceId: "w",
      env: { YOUTUBE_API_KEY: "k" },
      fetchImpl: vi.fn().mockResolvedValue(json({ error: { message: "quotaExceeded" } }, 403)) as unknown as typeof fetch,
      searchLibrary: async () => [{ provider: "library", externalId: "r1", url: null, title: "Saved", description: null, authorName: null, thumbnailUrl: null, publishedAt: null, durationSeconds: 30, metrics: {}, retrievedAt: "now", referenceId: "r1" }],
    });
    expect(runs.map((r) => [r.provider, r.status])).toEqual([["library", "ok"], ["youtube", "error"], ["instagram_hashtag", "unavailable"]]);
    expect(runs[1]!.message).toMatch(/quotaExceeded/);
  });
});

describe("YouTube provider (mocked HTTP)", () => {
  it("is unavailable without an API key", async () => {
    expect(await youtubeProvider.availability({ workspaceId: "w", env: {} })).toMatchObject({ available: false });
  });

  it("searches, enriches with duration/stats and filters by format", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ items: [
        { id: { videoId: "aaaaaaaaaaa" }, snippet: { title: "Short one", channelTitle: "Ch", publishedAt: "2026-01-01T00:00:00Z", thumbnails: { high: { url: "https://i.ytimg.com/a.jpg" } } } },
        { id: { videoId: "bbbbbbbbbbb" }, snippet: { title: "Long one", channelTitle: "Ch" } },
      ] }))
      .mockResolvedValueOnce(json({ items: [
        { id: "aaaaaaaaaaa", contentDetails: { duration: "PT45S" }, statistics: { viewCount: "1200", likeCount: "80" } },
        { id: "bbbbbbbbbbb", contentDetails: { duration: "PT25M" }, statistics: { viewCount: "5" } },
      ] }));
    const results = await youtubeProvider.search(q, { workspaceId: "w", env: { YOUTUBE_API_KEY: "k" }, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ externalId: "aaaaaaaaaaa", durationSeconds: 45, metrics: { views: 1200, likes: 80 }, url: "https://www.youtube.com/watch?v=aaaaaaaaaaa" });
    expect(results[0]!.metrics).not.toHaveProperty("comments"); // absent stays absent — never invented
    const searchUrl = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(searchUrl.searchParams.get("q")).toBe("morning routine fitness");
    expect(searchUrl.searchParams.get("videoDuration")).toBe("short");
  });
});

describe("Instagram providers (mocked HTTP)", () => {
  it("own-media requires a connected account", async () => {
    expect(await instagramOwnMediaProvider.availability({ workspaceId: "w", getInstagramToken: async () => null })).toMatchObject({ available: false });
  });
  it("own-media filters videos by caption keywords", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: [
      { id: "1", caption: "My morning routine", media_type: "VIDEO", media_product_type: "REELS", permalink: "https://www.instagram.com/reel/AAAAA/", like_count: 10 },
      { id: "2", caption: "Lunch", media_type: "VIDEO", media_product_type: "REELS" },
      { id: "3", caption: "morning photo", media_type: "IMAGE" },
    ] }));
    const r = await instagramOwnMediaProvider.search({ ...q, niche: undefined }, { workspaceId: "w", getInstagramToken: async () => "tok", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(r.map((x) => x.externalId)).toEqual(["1"]);
    expect(r[0]!.metrics).toEqual({ likes: 10 });
  });
  it("hashtag search is documented but unavailable", async () => {
    expect(await instagramHashtagProvider.availability({ workspaceId: "w" })).toMatchObject({ available: false });
    await expect(instagramHashtagProvider.search(q, { workspaceId: "w" })).rejects.toThrow(/not available/);
  });
});

describe("format and duration helpers", () => {
  it("parses ISO-8601 durations", () => {
    expect(parseIsoDuration("PT1M5S")).toBe(65);
    expect(parseIsoDuration("PT1H")).toBe(3600);
    expect(parseIsoDuration("garbage")).toBeNull();
  });
  it("filters by format, keeping unknown durations", () => {
    expect(matchesFormat(30, "short")).toBe(true);
    expect(matchesFormat(300, "short")).toBe(false);
    expect(matchesFormat(null, "long")).toBe(true);
  });
});

describe("library filtering, sorting and pagination", () => {
  function recorder() {
    const calls: [string, ...unknown[]][] = [];
    type B = FilterBuilder<B> & { calls: typeof calls };
    const b: B = {
      calls,
      eq: (...a) => (calls.push(["eq", ...a]), b),
      or: (...a) => (calls.push(["or", ...a]), b),
      gte: (...a) => (calls.push(["gte", ...a]), b),
      lt: (...a) => (calls.push(["lt", ...a]), b),
      lte: (...a) => (calls.push(["lte", ...a]), b),
      order: (...a) => (calls.push(["order", ...a]), b),
      range: (...a) => (calls.push(["range", ...a]), b),
    };
    return b;
  }

  it("parses untrusted params safely with defaults", () => {
    expect(parseLibraryParams({ sort: "drop table", page: "-3", source: "evil", tag: "BAD TAG!" })).toMatchObject({ sort: "newest", page: 1, source: null, tag: null, format: "any" });
    expect(parseLibraryParams({ q: "hooks),x", status: "analyzed", page: "3", sort: "title", tag: "b-roll" })).toMatchObject({ q: "hooks x", status: "analyzed", page: 3, sort: "title", tag: "b-roll" });
  });

  it("applies every filter, sort and page range", () => {
    const b = recorder();
    applyLibraryFilters(b, parseLibraryParams({ q: "hook", category: "Education", source: "instagram", status: "analyzed", tag: "b-roll", format: "short", sort: "oldest", page: "2" }), 24);
    expect(b.calls).toEqual([
      ["or", "title.ilike.%hook%,description.ilike.%hook%,author_name.ilike.%hook%,notes.ilike.%hook%"],
      ["eq", "category", "Education"],
      ["eq", "source_type", "instagram"],
      ["eq", "analysis_status", "analyzed"],
      ["eq", "reference_tags.tag", "b-roll"],
      ["lt", "duration_seconds", 240],
      ["order", "created_at", { ascending: true, nullsFirst: false }],
      ["range", 24, 47],
    ]);
  });
});

describe("URL accessibility check (mocked HTTP, no video download)", () => {
  const ig = parseReferenceUrl("https://www.instagram.com/reel/ABCDE12345/") as Extract<ReturnType<typeof parseReferenceUrl>, { ok: true }>;
  const yt = parseReferenceUrl("https://youtu.be/dQw4w9WgXcQ") as Extract<ReturnType<typeof parseReferenceUrl>, { ok: true }>;

  it("requests only the canonical URL with HEAD and no redirects", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const r = await checkReferenceUrl(ig, fetchImpl as unknown as typeof fetch);
    expect(r.status).toBe("reachable");
    expect(fetchImpl).toHaveBeenCalledWith("https://www.instagram.com/reel/ABCDE12345/", expect.objectContaining({ method: "HEAD", redirect: "manual" }));
  });
  it("reports login walls and missing posts honestly", async () => {
    const login = vi.fn().mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://www.instagram.com/accounts/login/" } }));
    expect((await checkReferenceUrl(ig, login as unknown as typeof fetch)).status).toBe("login_required");
    const missing = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    expect((await checkReferenceUrl(ig, missing as unknown as typeof fetch)).status).toBe("not_found");
    const down = vi.fn().mockRejectedValue(new Error("network"));
    expect((await checkReferenceUrl(ig, down as unknown as typeof fetch)).status).toBe("unverifiable");
  });
  it("uses YouTube oEmbed for metadata", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ title: "Video", author_name: "Channel", thumbnail_url: "https://i.ytimg.com/x.jpg" }));
    const r = await checkReferenceUrl(yt, fetchImpl as unknown as typeof fetch);
    expect(r).toMatchObject({ status: "reachable", metadata: { title: "Video", authorName: "Channel" } });
    expect(String(fetchImpl.mock.calls[0]![0])).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?/);
  });
  it("never fetches other sites", async () => {
    const fetchImpl = vi.fn();
    const web = parseReferenceUrl("https://example.com/x") as Extract<ReturnType<typeof parseReferenceUrl>, { ok: true }>;
    expect((await checkReferenceUrl(web, fetchImpl as unknown as typeof fetch)).status).toBe("not_checked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
