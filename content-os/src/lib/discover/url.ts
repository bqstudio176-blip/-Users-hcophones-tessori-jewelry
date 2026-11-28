/**
 * Reference URL parsing. Pure and framework-free.
 *
 * Security: the server only ever fetches CANONICAL URLs it builds itself for
 * allow-listed hosts (Instagram, YouTube). User-supplied URLs for any other
 * site are stored as links but never fetched (SSRF prevention).
 */
export type ParsedReferenceUrl =
  | {
      ok: true;
      sourceType: "instagram" | "youtube" | "web";
      provider: "manual";
      kind: "instagram_reel" | "instagram_post" | "youtube_video" | "youtube_short" | "web_link";
      externalId: string | null;
      normalized: string;
      canonicalUrl: string;
    }
  | { ok: false; error: string };

const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com", "m.instagram.com"]);
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);
const IG_CODE = /^[A-Za-z0-9_-]{5,64}$/;
const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|igsh|igshid|si|feature|ref)$/i;

function isIpLiteral(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || /^[0-9a-f:]+$/i.test(host) && host.includes(":");
}

export function parseReferenceUrl(input: string): ParsedReferenceUrl {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, error: "Enter a URL." };
  if (raw.length > 2048) return { ok: false, error: "URL is too long." };

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, error: "That is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Only https:// links are supported." };
  if (url.username || url.password) return { ok: false, error: "URLs with credentials are not allowed." };
  if (url.port && url.port !== "443") return { ok: false, error: "Custom ports are not allowed." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIpLiteral(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || !host.includes(".")) {
    return { ok: false, error: "That host is not allowed." };
  }
  const segments = url.pathname.split("/").filter(Boolean);

  if (INSTAGRAM_HOSTS.has(host)) {
    // /reel/{code}, /reels/{code}, /p/{code}, /tv/{code}, optionally prefixed by /{username}
    const i = segments.findIndex((s) => ["reel", "reels", "p", "tv"].includes(s));
    const kindSeg = i >= 0 ? segments[i] : undefined;
    const code = i >= 0 ? segments[i + 1] : undefined;
    if (!kindSeg || !code || !IG_CODE.test(code) || i > 1) {
      return { ok: false, error: "Paste a link to a specific Instagram Reel or post." };
    }
    const isPost = kindSeg === "p";
    return {
      ok: true,
      sourceType: "instagram",
      provider: "manual",
      kind: isPost ? "instagram_post" : "instagram_reel",
      externalId: code,
      normalized: `instagram:${code}`,
      canonicalUrl: `https://www.instagram.com/${isPost ? "p" : "reel"}/${code}/`,
    };
  }

  if (YOUTUBE_HOSTS.has(host) || host === "youtu.be") {
    let id: string | null = null;
    let isShort = false;
    if (host === "youtu.be") id = segments[0] ?? null;
    else if (segments[0] === "watch") id = url.searchParams.get("v");
    else if (segments[0] === "shorts" || segments[0] === "embed" || segments[0] === "live") {
      id = segments[1] ?? null;
      isShort = segments[0] === "shorts";
    }
    if (!id || !YT_ID.test(id)) return { ok: false, error: "Paste a link to a specific YouTube video or Short." };
    return {
      ok: true,
      sourceType: "youtube",
      provider: "manual",
      kind: isShort ? "youtube_short" : "youtube_video",
      externalId: id,
      normalized: `youtube:${id}`,
      canonicalUrl: isShort ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
    };
  }

  // Any other site: keep as a link (never fetched server-side).
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMS.test(key)) url.searchParams.delete(key);
  url.hash = "";
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const query = url.searchParams.toString();
  return {
    ok: true,
    sourceType: "web",
    provider: "manual",
    kind: "web_link",
    externalId: null,
    normalized: `web:${host}${path}${query ? `?${query}` : ""}`,
    canonicalUrl: `https://${host}${path}${query ? `?${query}` : ""}`,
  };
}
