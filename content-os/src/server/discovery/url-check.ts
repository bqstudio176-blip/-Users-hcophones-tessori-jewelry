import type { ParsedReferenceUrl } from "@/lib/discover/url";

/**
 * Determines whether an imported URL is actually reachable, WITHOUT
 * downloading any video. Only canonical URLs on fixed hosts are requested,
 * redirects are not followed, and requests time out after 6 seconds.
 */
export interface UrlCheckResult {
  status: "reachable" | "login_required" | "not_found" | "private" | "unverifiable" | "not_checked";
  checkedAt: string;
  httpStatus?: number;
  note: string;
  metadata?: { title?: string; authorName?: string; thumbnailUrl?: string };
}

type Parsed = Extract<ParsedReferenceUrl, { ok: true }>;

export async function checkReferenceUrl(parsed: Parsed, fetchImpl: typeof fetch = fetch): Promise<UrlCheckResult> {
  const checkedAt = new Date().toISOString();
  try {
    if (parsed.sourceType === "youtube") {
      const url = new URL("https://www.youtube.com/oembed");
      url.searchParams.set("format", "json");
      url.searchParams.set("url", parsed.canonicalUrl);
      const res = await fetchImpl(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(6000) });
      if (res.status === 200) {
        const j = (await res.json().catch(() => ({}))) as { title?: string; author_name?: string; thumbnail_url?: string };
        return {
          status: "reachable",
          checkedAt,
          httpStatus: 200,
          note: "Public video found via YouTube oEmbed. The video file is not downloaded — upload it to analyze.",
          metadata: {
            title: j.title,
            authorName: j.author_name,
            thumbnailUrl: j.thumbnail_url?.startsWith("https://") ? j.thumbnail_url : undefined,
          },
        };
      }
      if (res.status === 401 || res.status === 403) return { status: "private", checkedAt, httpStatus: res.status, note: "The video is private or does not allow embedding." };
      if (res.status === 404 || res.status === 400) return { status: "not_found", checkedAt, httpStatus: res.status, note: "YouTube reports that this video does not exist." };
      return { status: "unverifiable", checkedAt, httpStatus: res.status, note: `YouTube returned HTTP ${res.status}.` };
    }

    if (parsed.sourceType === "instagram") {
      const res = await fetchImpl(parsed.canonicalUrl, { method: "HEAD", redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(6000) });
      const location = res.headers.get("location") ?? "";
      if (res.status === 200) {
        return { status: "reachable", checkedAt, httpStatus: 200, note: "The Instagram page responded. Instagram does not permit downloading the video — upload the file to analyze it." };
      }
      if (res.status >= 300 && res.status < 400 && /accounts\/login|challenge/.test(location)) {
        return { status: "login_required", checkedAt, httpStatus: res.status, note: "Instagram requires login to view this link (private, age-restricted or rate-limited). Upload the video to analyze it." };
      }
      if (res.status === 404) return { status: "not_found", checkedAt, httpStatus: 404, note: "Instagram reports that this post does not exist." };
      return { status: "unverifiable", checkedAt, httpStatus: res.status, note: `Instagram returned HTTP ${res.status}; accessibility could not be confirmed.` };
    }

    return { status: "not_checked", checkedAt, note: "Links to other sites are saved but not fetched by the server." };
  } catch {
    return { status: "unverifiable", checkedAt, note: "The source could not be reached from the server (timeout or network policy)." };
  }
}
