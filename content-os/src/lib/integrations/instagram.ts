import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Instagram connection foundation (Instagram API with Instagram Login).
 *
 * Phase 1 scope: connect an account, read its basic profile, store an
 * encrypted long-lived token, disconnect. NO publishing (Phase 2+).
 *
 * STATUS: implemented against Meta's documented endpoints but NOT verified
 * against a live Meta app in this phase (no app credentials were available).
 * See IMPLEMENTATION_STATUS.md.
 */
export const INSTAGRAM_SCOPES = ["instagram_business_basic"] as const;
const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
const TOKEN_URL = "https://api.instagram.com/oauth/access_token";
const GRAPH_URL = "https://graph.instagram.com";
const GRAPH_VERSION = "v21.0";
const STATE_TTL_SECONDS = 10 * 60;
export const IG_NONCE_COOKIE = "cos_ig_nonce";

export interface OAuthStatePayload {
  workspaceId: string;
  userId: string;
  nonce: string;
  exp: number; // unix seconds
}

function sign(data: string, secret: string) {
  return createHmac("sha256", secret).update(data).digest("base64url");
}

/** Creates a signed, expiring state value plus the nonce to bind in a cookie. */
export function createOAuthState(
  input: { workspaceId: string; userId: string },
  secret: string,
  now = Date.now(),
): { state: string; nonce: string } {
  const nonce = randomBytes(16).toString("base64url");
  const payload: OAuthStatePayload = {
    workspaceId: input.workspaceId,
    userId: input.userId,
    nonce,
    exp: Math.floor(now / 1000) + STATE_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return { state: `${body}.${sign(body, secret)}`, nonce };
}

/**
 * Verifies signature, expiry, browser binding (nonce cookie) and that the
 * callback is completed by the same user who started it.
 */
export function verifyOAuthState(
  state: string | null,
  opts: { secret: string; nonceCookie: string | undefined; userId: string; now?: number },
): OAuthStatePayload {
  if (!state) throw new Error("Missing state");
  const [body, signature] = state.split(".");
  if (!body || !signature) throw new Error("Malformed state");
  const expected = Buffer.from(sign(body, opts.secret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Invalid state signature");
  }
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("Malformed state");
  }
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  if (typeof payload.exp !== "number" || payload.exp < nowSec) throw new Error("State expired");
  if (!opts.nonceCookie || opts.nonceCookie !== payload.nonce) throw new Error("State not bound to this browser");
  if (payload.userId !== opts.userId) throw new Error("State belongs to a different user");
  return payload;
}

export function buildAuthorizeUrl(opts: { appId: string; redirectUri: string; state: string }): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", opts.appId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INSTAGRAM_SCOPES.join(","));
  url.searchParams.set("state", opts.state);
  return url.toString();
}

export interface InstagramConnection {
  accessToken: string;
  expiresAt: Date | null;
  externalAccountId: string;
  username: string | null;
  displayName: string | null;
  accountType: string | null;
  profilePictureUrl: string | null;
  scopes: string[];
}

type FetchLike = typeof fetch;

async function readJson(res: Response, step: string) {
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Instagram ${step} returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const msg = (json as { error_message?: string; error?: { message?: string } })?.error_message
      ?? (json as { error?: { message?: string } })?.error?.message
      ?? `HTTP ${res.status}`;
    throw new Error(`Instagram ${step} failed: ${msg}`);
  }
  return json as Record<string, unknown>;
}

/** Code → short-lived token → long-lived token → basic profile. */
export async function exchangeCodeForConnection(
  opts: { code: string; appId: string; appSecret: string; redirectUri: string },
  fetchImpl: FetchLike = fetch,
): Promise<InstagramConnection> {
  const form = new URLSearchParams({
    client_id: opts.appId,
    client_secret: opts.appSecret,
    grant_type: "authorization_code",
    redirect_uri: opts.redirectUri,
    code: opts.code,
  });
  const shortRes = await readJson(
    await fetchImpl(TOKEN_URL, { method: "POST", body: form, cache: "no-store" }),
    "token exchange",
  );
  // The endpoint has returned both a flat object and { data: [ … ] } historically.
  const short = (Array.isArray(shortRes.data) ? shortRes.data[0] : shortRes) as Record<string, unknown>;
  const shortToken = String(short.access_token ?? "");
  if (!shortToken) throw new Error("Instagram token exchange returned no access token");
  const permissions = short.permissions;
  const scopes = Array.isArray(permissions)
    ? permissions.map(String)
    : typeof permissions === "string"
      ? permissions.split(",")
      : [...INSTAGRAM_SCOPES];

  const longUrl = new URL(`${GRAPH_URL}/access_token`);
  longUrl.searchParams.set("grant_type", "ig_exchange_token");
  longUrl.searchParams.set("client_secret", opts.appSecret);
  longUrl.searchParams.set("access_token", shortToken);
  const long = await readJson(await fetchImpl(longUrl, { cache: "no-store" }), "long-lived token exchange");
  const accessToken = String(long.access_token ?? "");
  if (!accessToken) throw new Error("Instagram long-lived exchange returned no access token");
  const expiresIn = Number(long.expires_in);

  const meUrl = new URL(`${GRAPH_URL}/${GRAPH_VERSION}/me`);
  meUrl.searchParams.set("fields", "user_id,username,name,account_type,profile_picture_url");
  meUrl.searchParams.set("access_token", accessToken);
  const me = await readJson(await fetchImpl(meUrl, { cache: "no-store" }), "profile lookup");

  return {
    accessToken,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000) : null,
    externalAccountId: String(me.user_id ?? me.id ?? short.user_id ?? ""),
    username: me.username ? String(me.username) : null,
    displayName: me.name ? String(me.name) : null,
    accountType: me.account_type ? String(me.account_type) : null,
    profilePictureUrl: me.profile_picture_url ? String(me.profile_picture_url) : null,
    scopes,
  };
}
