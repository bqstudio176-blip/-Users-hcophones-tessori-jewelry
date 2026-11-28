/**
 * Pure route-protection rules used by the proxy. Kept framework-free so it can
 * be unit-tested exhaustively.
 */
export type RouteDecision =
  | { type: "allow" }
  | { type: "redirect"; to: string; next?: string };

/** Pages only for signed-out visitors. */
const GUEST_ONLY = ["/login", "/register", "/forgot-password"];

/** Always reachable regardless of auth state. */
const PUBLIC_PREFIXES = ["/auth/", "/api/health", "/verify-email", "/reset-password", "/invite/"];

export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/discover",
  "/analyze",
  "/script-lab",
  "/video-studio",
  "/experiments",
  "/publish",
  "/analytics",
  "/settings",
  "/onboarding",
  "/admin",
  "/api/connections",
  "/api/analyses",
];

function matches(pathname: string, prefix: string) {
  if (prefix.endsWith("/")) return pathname.startsWith(prefix);
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => matches(pathname, p));
}

export function decideRouteAccess(pathname: string, isAuthenticated: boolean): RouteDecision {
  if (PUBLIC_PREFIXES.some((p) => matches(pathname, p))) return { type: "allow" };

  if (GUEST_ONLY.some((p) => matches(pathname, p))) {
    return isAuthenticated ? { type: "redirect", to: "/dashboard" } : { type: "allow" };
  }

  if (pathname === "/") {
    return { type: "redirect", to: isAuthenticated ? "/dashboard" : "/login" };
  }

  if (isProtectedPath(pathname) && !isAuthenticated) {
    return { type: "redirect", to: "/login", next: pathname };
  }

  return { type: "allow" };
}

/**
 * Validates a post-login redirect target. Only same-origin relative paths are
 * allowed (prevents open redirects such as `//evil.com` or `https://…`).
 */
export function safeNextPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || typeof next !== "string") return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  try {
    const url = new URL(next, "http://internal.invalid");
    if (url.origin !== "http://internal.invalid") return fallback;
    return url.pathname + url.search;
  } catch {
    return fallback;
  }
}
