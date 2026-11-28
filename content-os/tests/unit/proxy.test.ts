import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ claims: null as null | { sub: string } }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getClaims: async () => ({ data: auth.claims ? { claims: auth.claims } : null, error: null }) },
  }),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";

const { proxy } = await import("@/proxy");
const req = (path: string) => new NextRequest(new URL(path, "https://app.test"));

beforeEach(() => {
  auth.claims = null;
});

describe("proxy route protection", () => {
  it.each(["/admin", "/admin/users", "/admin/workspaces/abc", "/dashboard", "/settings/security", "/api/connections/instagram/start"])(
    "redirects anonymous requests for %s to /login with next",
    async (path) => {
      const res = await proxy(req(path));
      expect(res.status).toBe(307);
      const loc = new URL(res.headers.get("location")!);
      expect(loc.pathname).toBe("/login");
      expect(loc.searchParams.get("next")).toBe(path);
    },
  );

  it("lets authenticated requests through (role checks happen server-side)", async () => {
    auth.claims = { sub: "user-1" };
    const res = await proxy(req("/admin"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("redirects signed-in users away from /login", async () => {
    auth.claims = { sub: "user-1" };
    const res = await proxy(req("/login"));
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard");
  });

  it("does not leak query strings into the redirect", async () => {
    const res = await proxy(req("/dashboard?token=secret"));
    expect(res.headers.get("location")).not.toContain("secret");
  });
});
