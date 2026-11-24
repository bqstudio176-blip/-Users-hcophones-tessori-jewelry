import { combinedQuery, ProviderError, type DiscoveryProvider, type DiscoveryResult } from "../types";

interface IgMedia {
  id: string;
  caption?: string;
  media_type?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  media_url?: string;
  timestamp?: string;
  like_count?: number;
  comments_count?: number;
}

/**
 * Media published by the workspace's OWN connected Instagram account
 * (Instagram API with Instagram Login, scope instagram_business_basic).
 * NOT verified against a live Meta app in this phase.
 */
export const instagramOwnMediaProvider: DiscoveryProvider = {
  id: "instagram_own_media",
  name: "Instagram (your account)",
  supportsSearch: true,
  supportsTrending: false,
  docs: {
    capabilities: ["List and keyword-filter media published by the connected account"],
    authentication: "The workspace's connected Instagram professional account (Settings → Connections).",
    rateLimits: "Meta Platform rate limits apply (calls per hour scale with account impressions).",
    metadata: ["Caption", "Media type", "Permalink", "Thumbnail", "Timestamp", "Like and comment counts (when returned)"],
    restrictions: "Only the connected account's own media. Other creators' content is not accessible through this API.",
    costs: "Free.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login",
  },
  async availability(ctx) {
    if (!ctx.getInstagramToken) return { available: false, reason: "Instagram is not configured on this deployment." };
    const token = await ctx.getInstagramToken();
    return token
      ? { available: true }
      : { available: false, reason: "Connect an Instagram account to search its media.", action: { label: "Connect", href: "/settings/connections" } };
  },
  async search(q, ctx) {
    const token = await ctx.getInstagramToken?.();
    if (!token) throw new ProviderError("instagram_own_media", "No connected Instagram account");
    const url = new URL("https://graph.instagram.com/v21.0/me/media");
    url.searchParams.set("fields", "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count");
    url.searchParams.set("limit", "50");
    url.searchParams.set("access_token", token);
    const res = await (ctx.fetchImpl ?? fetch)(url, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
    const body = (await res.json().catch(() => ({}))) as { data?: IgMedia[]; error?: { message?: string } };
    if (!res.ok) throw new ProviderError("instagram_own_media", body.error?.message ?? `HTTP ${res.status}`, res.status);
    const retrievedAt = new Date().toISOString();
    const terms = combinedQuery(q).toLowerCase().split(/\s+/).filter(Boolean);
    return (body.data ?? [])
      .filter((m) => m.media_type === "VIDEO" || m.media_product_type === "REELS")
      .filter((m) => terms.length === 0 || terms.some((t) => (m.caption ?? "").toLowerCase().includes(t)))
      .slice(0, q.limit)
      .map((m): DiscoveryResult => {
        const metrics: Record<string, number> = {};
        if (typeof m.like_count === "number") metrics.likes = m.like_count;
        if (typeof m.comments_count === "number") metrics.comments = m.comments_count;
        const thumb = m.thumbnail_url ?? null;
        return {
          provider: "instagram_own_media",
          externalId: m.id,
          url: m.permalink?.startsWith("https://") ? m.permalink : null,
          title: (m.caption ?? "").split("\n")[0]?.slice(0, 120) || "Instagram media",
          description: m.caption ?? null,
          authorName: null,
          thumbnailUrl: thumb?.startsWith("https://") ? thumb : null,
          publishedAt: m.timestamp ?? null,
          durationSeconds: null,
          metrics,
          retrievedAt,
        };
      });
  },
};

/** Documented but intentionally unavailable: requires access this project does not have. */
export const instagramHashtagProvider: DiscoveryProvider = {
  id: "instagram_hashtag",
  name: "Instagram hashtag search",
  supportsSearch: true,
  supportsTrending: false,
  docs: {
    capabilities: ["Top and recent public media for a hashtag (IG Hashtag Search)"],
    authentication: "Facebook Login for Business with a Facebook Page linked to an Instagram professional account; permissions instagram_basic + Instagram Public Content Access feature (requires Meta App Review).",
    rateLimits: "30 unique hashtags per Instagram account per rolling 7 days.",
    metadata: ["Caption", "Media type", "Permalink", "Like/comment counts", "Timestamp"],
    restrictions: "Not available with Instagram Login (used by Content OS Phase 1). Does not return creator identity. Personal data must not be stored beyond permitted use.",
    costs: "Free; Meta App Review required.",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-hashtag-search",
  },
  async availability() {
    return { available: false, reason: "Requires Facebook Login for Business and Meta App Review (Instagram Public Content Access). Not enabled on this deployment." };
  },
  async search() {
    throw new ProviderError("instagram_hashtag", "Instagram hashtag search is not available on this deployment");
  },
};
