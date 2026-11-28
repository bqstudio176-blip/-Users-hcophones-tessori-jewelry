import { libraryProvider } from "./providers/library";
import { instagramHashtagProvider, instagramOwnMediaProvider } from "./providers/instagram";
import { youtubeProvider } from "./providers/youtube";
import type { DiscoveryProvider, DiscoveryQuery, DiscoveryResult, ProviderContext } from "./types";

export const DISCOVERY_PROVIDERS: DiscoveryProvider[] = [libraryProvider, youtubeProvider, instagramOwnMediaProvider, instagramHashtagProvider];

export function getProvider(id: string): DiscoveryProvider | undefined {
  return DISCOVERY_PROVIDERS.find((p) => p.id === id);
}

export interface ProviderRun {
  provider: string;
  status: "ok" | "unavailable" | "error";
  results: DiscoveryResult[];
  message?: string;
}

/**
 * Runs the selected providers in parallel. A failing or unavailable provider
 * never breaks the others; its status is reported to the user.
 */
export async function runDiscovery(providerIds: string[], q: DiscoveryQuery, ctx: ProviderContext): Promise<ProviderRun[]> {
  const selected = providerIds.map(getProvider).filter((p): p is DiscoveryProvider => Boolean(p));
  return Promise.all(
    selected.map(async (p): Promise<ProviderRun> => {
      const availability = await p.availability(ctx).catch(() => ({ available: false as const, reason: "Availability check failed" }));
      if (!availability.available) return { provider: p.id, status: "unavailable", results: [], message: availability.reason };
      try {
        const results = await p.search(q, ctx);
        return { provider: p.id, status: "ok", results };
      } catch (err) {
        return { provider: p.id, status: "error", results: [], message: err instanceof Error ? err.message.slice(0, 300) : "Provider error" };
      }
    }),
  );
}
