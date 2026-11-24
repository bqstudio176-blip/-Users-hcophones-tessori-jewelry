import { describe, expect, it } from "vitest";
import { decideRouteAccess, PROTECTED_PREFIXES, safeNextPath } from "@/lib/auth/route-access";

describe("decideRouteAccess", () => {
  it.each(PROTECTED_PREFIXES)("redirects anonymous visitors away from %s", (path) => {
    expect(decideRouteAccess(path, false)).toEqual({ type: "redirect", to: "/login", next: path });
    expect(decideRouteAccess(`${path}/nested`, false)).toMatchObject({ type: "redirect", to: "/login" });
  });

  it.each(PROTECTED_PREFIXES)("allows authenticated users into %s", (path) => {
    expect(decideRouteAccess(path, true)).toEqual({ type: "allow" });
  });

  it("protects every admin route for anonymous visitors", () => {
    for (const p of ["/admin", "/admin/users", "/admin/workspaces/123", "/admin/activity"]) {
      expect(decideRouteAccess(p, false)).toMatchObject({ type: "redirect", to: "/login" });
    }
  });

  it("does not treat look-alike paths as protected prefixes", () => {
    expect(decideRouteAccess("/administrator", false)).toEqual({ type: "allow" });
    expect(decideRouteAccess("/dashboards", false)).toEqual({ type: "allow" });
  });

  it("sends signed-in users away from guest-only pages", () => {
    for (const p of ["/login", "/register", "/forgot-password"]) {
      expect(decideRouteAccess(p, true)).toEqual({ type: "redirect", to: "/dashboard" });
      expect(decideRouteAccess(p, false)).toEqual({ type: "allow" });
    }
  });

  it("keeps auth callbacks, invitations, verify/reset and health public", () => {
    for (const p of ["/auth/confirm", "/auth/callback", "/invite/abc", "/verify-email", "/reset-password", "/api/health"]) {
      expect(decideRouteAccess(p, false)).toEqual({ type: "allow" });
      expect(decideRouteAccess(p, true)).toEqual({ type: "allow" });
    }
  });

  it("routes the root by auth state", () => {
    expect(decideRouteAccess("/", false)).toEqual({ type: "redirect", to: "/login" });
    expect(decideRouteAccess("/", true)).toEqual({ type: "redirect", to: "/dashboard" });
  });
});

describe("safeNextPath (open-redirect protection)", () => {
  it("accepts same-origin relative paths", () => {
    expect(safeNextPath("/settings/members")).toBe("/settings/members");
    expect(safeNextPath("/invite/abc?x=1")).toBe("/invite/abc?x=1");
  });
  it.each(["https://evil.com", "//evil.com", "/\\evil.com", "javascript:alert(1)", "evil.com", "", "/\u0000x"])("rejects %j", (bad) => {
    expect(safeNextPath(bad)).toBe("/dashboard");
  });
  it("uses the provided fallback", () => {
    expect(safeNextPath(null, "/onboarding")).toBe("/onboarding");
  });
});
