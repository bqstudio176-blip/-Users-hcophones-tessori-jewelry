import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Server-side authorization guards, with Supabase and Next.js runtime mocked.
 * Verifies that admin routes 404 for non-admins, unauthenticated users are
 * redirected, and a tampered active-workspace cookie cannot select a tenant
 * the user does not belong to.
 */
const state = vi.hoisted(() => ({
  user: null as null | { id: string; email: string; email_confirmed_at: string | null },
  profile: null as null | Record<string, unknown>,
  memberships: [] as Array<{ role: string; workspace: { id: string; name: string } }>,
  cookie: undefined as string | undefined,
  rpc: vi.fn(),
}));

class RedirectError extends Error {
  constructor(public url: string) {
    super(`REDIRECT:${url}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new RedirectError(url);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (state.cookie ? { value: state.cookie } : undefined), set: vi.fn(), delete: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => {
  const builder = (table: string) => {
    const chain = {
      select: () => chain,
      eq: () => chain,
      order: () =>
        Promise.resolve({ data: table === "workspace_members" ? state.memberships : [], error: null }),
      maybeSingle: () => Promise.resolve({ data: table === "profiles" ? state.profile : null, error: null }),
    };
    return chain;
  };
  return {
    createClient: async () => ({
      auth: { getUser: async () => ({ data: { user: state.user }, error: state.user ? null : new Error("no session") }) },
      from: builder,
      rpc: state.rpc,
    }),
  };
});

const verified = { id: "u1", email: "u1@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };

beforeEach(() => {
  vi.resetModules();
  state.user = null;
  state.profile = null;
  state.memberships = [];
  state.cookie = undefined;
  state.rpc.mockReset();
});

async function session() {
  return import("@/lib/auth/session");
}

describe("requirePlatformAdmin (protects /admin)", () => {
  it("redirects anonymous users to /login", async () => {
    const { requirePlatformAdmin } = await session();
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ url: "/login" });
  });
  it("redirects unverified users to /verify-email", async () => {
    state.user = { ...verified, email_confirmed_at: null };
    const { requirePlatformAdmin } = await session();
    await expect(requirePlatformAdmin()).rejects.toMatchObject({ url: "/verify-email" });
  });
  it("responds 404 to authenticated non-admins (including workspace owners)", async () => {
    state.user = verified;
    state.profile = { id: "u1", email: verified.email, is_platform_admin: false, preferences: {} };
    state.memberships = [{ role: "owner", workspace: { id: "w1", name: "Mine" } }];
    const { requirePlatformAdmin } = await session();
    await expect(requirePlatformAdmin()).rejects.toThrow("NOT_FOUND");
  });
  it("admits platform admins", async () => {
    state.user = verified;
    state.profile = { id: "u1", email: verified.email, is_platform_admin: true, preferences: {} };
    const { requirePlatformAdmin } = await session();
    await expect(requirePlatformAdmin()).resolves.toMatchObject({ profile: { is_platform_admin: true } });
  });
});

describe("admin server action", () => {
  it("rejects non-admins before touching the database", async () => {
    state.user = verified;
    state.profile = { id: "u1", email: verified.email, is_platform_admin: false, preferences: {} };
    const { adjustCredits } = await import("@/server/actions/admin");
    const fd = new FormData();
    fd.set("workspaceId", "3f1c2a64-8a0e-4c39-9b7f-0d6c1a2b3c4d");
    fd.set("amount", "1000");
    fd.set("reason", "free credits");
    await expect(adjustCredits({ status: "idle" }, fd)).rejects.toThrow("NOT_FOUND");
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe("getWorkspaceContext", () => {
  beforeEach(() => {
    state.user = verified;
    state.profile = { id: "u1", email: verified.email, is_platform_admin: false, preferences: {} };
  });

  it("sends users without a workspace to onboarding", async () => {
    const { getWorkspaceContext } = await session();
    await expect(getWorkspaceContext()).rejects.toMatchObject({ url: "/onboarding" });
  });

  it("honours the active-workspace cookie only for workspaces the user belongs to", async () => {
    state.memberships = [
      { role: "owner", workspace: { id: "w1", name: "A" } },
      { role: "member", workspace: { id: "w2", name: "B" } },
    ];
    state.cookie = "w2";
    let { getWorkspaceContext } = await session();
    expect((await getWorkspaceContext()).workspace.id).toBe("w2");

    vi.resetModules();
    state.cookie = "someone-elses-workspace";
    ({ getWorkspaceContext } = await session());
    const ctx = await getWorkspaceContext();
    expect(ctx.workspace.id).toBe("w1");
    expect(ctx.role).toBe("owner");
  });

  it("requireWorkspacePermission throws Forbidden for insufficient roles", async () => {
    state.memberships = [{ role: "member", workspace: { id: "w1", name: "A" } }];
    const { requireWorkspacePermission, ForbiddenError } = await session();
    await expect(requireWorkspacePermission("settings.update")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireWorkspacePermission("workspace.view")).resolves.toMatchObject({ role: "member" });
  });

  it("server actions refuse member-level users for manager actions without calling the DB", async () => {
    state.memberships = [{ role: "member", workspace: { id: "w1", name: "A" } }];
    const { inviteMember } = await import("@/server/actions/workspace");
    const fd = new FormData();
    fd.set("email", "x@example.test");
    fd.set("role", "member");
    const res = await inviteMember({ status: "idle" }, fd);
    expect(res).toMatchObject({ status: "error", message: expect.stringMatching(/permission/) });
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
