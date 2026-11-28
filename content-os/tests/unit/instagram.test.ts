import { describe, expect, it, vi } from "vitest";
import { buildAuthorizeUrl, createOAuthState, exchangeCodeForConnection, verifyOAuthState } from "@/lib/integrations/instagram";

const SECRET = "test-secret-at-least-32-characters-long";

describe("OAuth state", () => {
  it("verifies a valid state bound to the same browser and user", () => {
    const { state, nonce } = createOAuthState({ workspaceId: "ws-1", userId: "u-1" }, SECRET);
    expect(verifyOAuthState(state, { secret: SECRET, nonceCookie: nonce, userId: "u-1" })).toMatchObject({ workspaceId: "ws-1" });
  });
  it("rejects a forged signature", () => {
    const { state, nonce } = createOAuthState({ workspaceId: "ws-1", userId: "u-1" }, SECRET);
    const [body] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), workspaceId: "victim" })).toString("base64url");
    expect(() => verifyOAuthState(`${forged}.${state.split(".")[1]}`, { secret: SECRET, nonceCookie: nonce, userId: "u-1" })).toThrow(/signature/);
  });
  it("rejects a state completed in another browser (no/mismatched nonce cookie)", () => {
    const { state } = createOAuthState({ workspaceId: "ws-1", userId: "u-1" }, SECRET);
    expect(() => verifyOAuthState(state, { secret: SECRET, nonceCookie: undefined, userId: "u-1" })).toThrow(/browser/);
    expect(() => verifyOAuthState(state, { secret: SECRET, nonceCookie: "other", userId: "u-1" })).toThrow(/browser/);
  });
  it("rejects a state completed by a different user", () => {
    const { state, nonce } = createOAuthState({ workspaceId: "ws-1", userId: "u-1" }, SECRET);
    expect(() => verifyOAuthState(state, { secret: SECRET, nonceCookie: nonce, userId: "u-2" })).toThrow(/different user/);
  });
  it("rejects an expired state", () => {
    const { state, nonce } = createOAuthState({ workspaceId: "ws-1", userId: "u-1" }, SECRET, Date.now() - 11 * 60_000);
    expect(() => verifyOAuthState(state, { secret: SECRET, nonceCookie: nonce, userId: "u-1" })).toThrow(/expired/);
  });
  it("rejects missing and malformed states", () => {
    expect(() => verifyOAuthState(null, { secret: SECRET, nonceCookie: "x", userId: "u" })).toThrow();
    expect(() => verifyOAuthState("nodot", { secret: SECRET, nonceCookie: "x", userId: "u" })).toThrow();
  });
});

describe("authorize URL", () => {
  it("requests only the basic scope (no publishing in Phase 1)", () => {
    const url = new URL(buildAuthorizeUrl({ appId: "123", redirectUri: "https://app.test/cb", state: "s" }));
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe("instagram_business_basic");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("s");
  });
});

describe("code exchange (mocked HTTP — not a live Meta integration test)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

  it("exchanges code → long-lived token → profile", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ data: [{ access_token: "short", user_id: "17841", permissions: "instagram_business_basic" }] }))
      .mockResolvedValueOnce(json({ access_token: "long", token_type: "bearer", expires_in: 5184000 }))
      .mockResolvedValueOnce(json({ user_id: "17841", username: "brand", name: "Brand", account_type: "BUSINESS" }));
    const conn = await exchangeCodeForConnection({ code: "c", appId: "a", appSecret: "s", redirectUri: "https://app.test/cb" }, fetchMock as unknown as typeof fetch);
    expect(conn).toMatchObject({ accessToken: "long", externalAccountId: "17841", username: "brand", accountType: "BUSINESS", scopes: ["instagram_business_basic"] });
    expect(conn.expiresAt).toBeInstanceOf(Date);
    const tokenCall = fetchMock.mock.calls[0]!;
    expect(String(tokenCall[0])).toBe("https://api.instagram.com/oauth/access_token");
    expect((tokenCall[1] as RequestInit).method).toBe("POST");
  });

  it("surfaces API errors without leaking secrets", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ error_message: "Invalid code" }, 400));
    await expect(
      exchangeCodeForConnection({ code: "bad", appId: "a", appSecret: "TOP-SECRET", redirectUri: "r" }, fetchMock as unknown as typeof fetch),
    ).rejects.toThrow(/Invalid code/);
    await expect(
      exchangeCodeForConnection({ code: "bad", appId: "a", appSecret: "TOP-SECRET", redirectUri: "r" }, vi.fn().mockResolvedValueOnce(json({ error_message: "x" }, 400)) as unknown as typeof fetch),
    ).rejects.not.toThrow(/TOP-SECRET/);
  });
});
