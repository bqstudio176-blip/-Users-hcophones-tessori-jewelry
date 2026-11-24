import { combinedQuery, matchesFormat, parseIsoDuration, ProviderError, type DiscoveryProvider, type DiscoveryResult } from "../types";

const API = "https://www.googleapis.com/youtube/v3";

interface YtItem {
  id: string | { videoId?: string };
  snippet?: { title?: string; description?: string; channelTitle?: string; publishedAt?: string; thumbnails?: Record<string, { url?: string }> };
  contentDetails?: { duration?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

async function getJson(fetchImpl: typeof fetch, url: URL): Promise<{ items?: YtItem[] }> {
  const res = await fetchImpl(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  const body = (await res.json().catch(() => ({}))) as { items?: YtItem[]; error?: { message?: string } };
  if (!res.ok) throw new ProviderError("youtube", body.error?.message ?? `HTTP ${res.status}`, res.status);
  return body;
}

/** Only counts YouTube actually returned (hidden like counts stay absent). */
function statsOf(item: YtItem): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const [k, v] of Object.entries({ views: item.statistics?.viewCount, likes: item.statistics?.likeCount, comments: item.statistics?.commentCount })) {
    if (v !== undefined && Number.isFinite(Number(v))) metrics[k] = Number(v);
  }
  return metrics;
}

function toResult(item: YtItem, retrievedAt: string): DiscoveryResult | null {
  const id = typeof item.id === "string" ? item.id : item.id?.videoId;
  if (!id || !item.snippet) return null;
  const t = item.snippet.thumbnails ?? {};
  const thumb = t.high?.url ?? t.medium?.url ?? t.default?.url ?? null;
  const metrics = statsOf(item);
  return {
    provider: "youtube",
    externalId: id,
    url: `https://www.youtube.com/watch?v=${id}`,
    title: item.snippet.title ?? "(untitled)",
    description: item.snippet.description ?? null,
    authorName: item.snippet.channelTitle ?? null,
    thumbnailUrl: thumb?.startsWith("https://") ? thumb : null,
    publishedAt: item.snippet.publishedAt ?? null,
    durationSeconds: parseIsoDuration(item.contentDetails?.duration),
    metrics,
    retrievedAt,
  };
}

/** Adds duration + statistics (videos.list costs 1 quota unit per call). */
async function enrich(fetchImpl: typeof fetch, key: string, ids: string[]): Promise<Map<string, YtItem>> {
  const out = new Map<string, YtItem>();
  if (ids.length === 0) return out;
  const url = new URL(`${API}/videos`);
  url.searchParams.set("part", "contentDetails,statistics");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("key", key);
  const body = await getJson(fetchImpl, url);
  for (const item of body.items ?? []) if (typeof item.id === "string") out.set(item.id, item);
  return out;
}

export const youtubeProvider: DiscoveryProvider = {
  id: "youtube",
  name: "YouTube",
  supportsSearch: true,
  supportsTrending: true,
  docs: {
    capabilities: ["Keyword search of public videos (search.list)", "Format filter via videoDuration", "Most-popular chart by region (videos.list chart=mostPopular)"],
    authentication: "Server API key (YOUTUBE_API_KEY) from a Google Cloud project with YouTube Data API v3 enabled.",
    rateLimits: "Default quota 10,000 units/day per project. search.list = 100 units, videos.list = 1 unit; one search here costs ~101 units (≈ 99 searches/day).",
    metadata: ["Title", "Description", "Channel", "Thumbnail", "Published date", "Duration", "View/like/comment counts (when public)"],
    restrictions: "Metadata only — the API does not provide video files; videos must not be downloaded. YouTube API Services Terms apply (data refresh/deletion obligations).",
    costs: "Free within quota; quota increases require a Google audit.",
    docsUrl: "https://developers.google.com/youtube/v3/docs/search/list",
  },
  async availability(ctx) {
    return ctx.env?.YOUTUBE_API_KEY
      ? { available: true }
      : { available: false, reason: "YOUTUBE_API_KEY is not configured on this deployment." };
  },
  async search(q, ctx) {
    const key = ctx.env?.YOUTUBE_API_KEY;
    if (!key) throw new ProviderError("youtube", "YOUTUBE_API_KEY is not configured");
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const text = combinedQuery(q);
    if (!text) return [];
    const url = new URL(`${API}/search`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", String(Math.min(q.limit, 25)));
    url.searchParams.set("q", text);
    url.searchParams.set("safeSearch", "moderate");
    if (q.format !== "any") url.searchParams.set("videoDuration", q.format);
    url.searchParams.set("key", key);
    const retrievedAt = new Date().toISOString();
    const body = await getJson(fetchImpl, url);
    const base = (body.items ?? []).map((i) => toResult(i, retrievedAt)).filter((r): r is DiscoveryResult => r !== null);
    const details = await enrich(fetchImpl, key, base.map((r) => r.externalId));
    return base
      .map((r) => {
        const d = details.get(r.externalId);
        return d ? { ...r, durationSeconds: parseIsoDuration(d.contentDetails?.duration), metrics: statsOf(d) } : r;
      })
      .filter((r) => matchesFormat(r.durationSeconds, q.format));
  },
  async trending(ctx, opts) {
    const key = ctx.env?.YOUTUBE_API_KEY;
    if (!key) throw new ProviderError("youtube", "YOUTUBE_API_KEY is not configured");
    const url = new URL(`${API}/videos`);
    url.searchParams.set("part", "snippet,contentDetails,statistics");
    url.searchParams.set("chart", "mostPopular");
    url.searchParams.set("regionCode", opts.regionCode);
    url.searchParams.set("maxResults", String(Math.min(opts.limit, 25)));
    url.searchParams.set("key", key);
    const retrievedAt = new Date().toISOString();
    const body = await getJson(ctx.fetchImpl ?? fetch, url);
    return (body.items ?? []).map((i) => toResult(i, retrievedAt)).filter((r): r is DiscoveryResult => r !== null);
  },
};

