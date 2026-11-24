import type { ContentFormat } from "@/lib/discover/catalog";

/**
 * Provider contract for automated discovery. Adding a source = implementing
 * this interface and registering it in registry.ts; the Discover module and
 * UI need no changes. Every provider documents its access model so the UI can
 * explain WHY a source is unavailable instead of pretending it works.
 */
export interface DiscoveryQuery {
  keywords: string;
  niche?: string;
  industry?: string;
  topic?: string;
  format: ContentFormat;
  category?: string; // library only
  limit: number;
}

export interface DiscoveryResult {
  provider: string;
  externalId: string;
  url: string | null;
  title: string;
  description: string | null;
  authorName: string | null;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  /** Only metrics the provider actually returned. Never estimated. */
  metrics: Record<string, number>;
  retrievedAt: string;
  /** Set when the result is already in the library. */
  referenceId?: string | null;
}

export interface ProviderDocs {
  capabilities: string[];
  authentication: string;
  rateLimits: string;
  metadata: string[];
  restrictions: string;
  costs: string;
  docsUrl: string | null;
}

export type ProviderAvailability =
  | { available: true }
  | { available: false; reason: string; action?: { label: string; href: string } };

export interface ProviderContext {
  workspaceId: string;
  /** Lazily provides the decrypted Instagram token for this workspace (server-only). */
  getInstagramToken?: () => Promise<string | null>;
  /** Library provider runs this RLS-scoped query. */
  searchLibrary?: (q: DiscoveryQuery) => Promise<DiscoveryResult[]>;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}

export interface DiscoveryProvider {
  id: string;
  name: string;
  docs: ProviderDocs;
  supportsSearch: boolean;
  supportsTrending: boolean;
  availability(ctx: ProviderContext): Promise<ProviderAvailability>;
  search(q: DiscoveryQuery, ctx: ProviderContext): Promise<DiscoveryResult[]>;
  trending?(ctx: ProviderContext, opts: { regionCode: string; limit: number }): Promise<DiscoveryResult[]>;
}

export class ProviderError extends Error {
  constructor(public provider: string, message: string, public status?: number) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Combines the free-text fields into one provider query string. */
export function combinedQuery(q: DiscoveryQuery): string {
  return [q.keywords, q.topic, q.niche, q.industry].map((s) => (s ?? "").trim()).filter(Boolean).join(" ").slice(0, 200);
}

/** Parses ISO-8601 durations such as PT1M5S → 65. */
export function parseIsoDuration(iso: string | undefined | null): number | null {
  if (!iso) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!m) return null;
  const [, d, h, min, s] = m;
  return Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

export function matchesFormat(durationSeconds: number | null, format: ContentFormat): boolean {
  if (format === "any" || durationSeconds === null) return true;
  if (format === "short") return durationSeconds < 240;
  if (format === "medium") return durationSeconds >= 240 && durationSeconds <= 1200;
  return durationSeconds > 1200;
}
