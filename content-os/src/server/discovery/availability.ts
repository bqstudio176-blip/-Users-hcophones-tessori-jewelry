import "server-only";
import { getWorkspaceInstagramToken } from "./instagram-token";
import { DISCOVERY_PROVIDERS } from "./registry";
import type { ProviderAvailability, ProviderContext } from "./types";

export function providerContext(workspaceId: string): ProviderContext {
  return { workspaceId, env: process.env, getInstagramToken: () => getWorkspaceInstagramToken(workspaceId) };
}

export async function providerAvailability(workspaceId: string) {
  const ctx = providerContext(workspaceId);
  return Promise.all(
    DISCOVERY_PROVIDERS.map(async (p) => ({ provider: p, availability: (await p.availability(ctx).catch(() => ({ available: false, reason: "Availability check failed" }))) as ProviderAvailability })),
  );
}
