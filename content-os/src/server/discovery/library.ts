import { CONTENT_FORMATS, sanitizeSearchTerm, type ContentFormat } from "@/lib/discover/catalog";
import type { DiscoveryQuery, DiscoveryResult } from "./types";

export const LIBRARY_PAGE_SIZE = 24;
export const LIBRARY_SORTS = {
  newest: { column: "created_at", ascending: false, label: "Newest" },
  oldest: { column: "created_at", ascending: true, label: "Oldest" },
  title: { column: "title", ascending: true, label: "Title A–Z" },
  duration: { column: "duration_seconds", ascending: false, label: "Longest" },
} as const;
export type LibrarySort = keyof typeof LIBRARY_SORTS;

const SOURCES = ["upload", "instagram", "youtube", "web"] as const;
const STATUSES = ["not_analyzed", "queued", "processing", "analyzed", "failed"] as const;

export interface LibraryParams {
  q: string;
  category: string | null;
  source: (typeof SOURCES)[number] | null;
  status: (typeof STATUSES)[number] | null;
  tag: string | null;
  format: ContentFormat;
  sort: LibrarySort;
  page: number;
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** Parses untrusted query-string params into a safe, bounded object. */
export function parseLibraryParams(sp: SP): LibraryParams {
  const source = one(sp.source);
  const status = one(sp.status);
  const sort = one(sp.sort);
  const format = one(sp.format);
  const tag = one(sp.tag).trim().toLowerCase();
  const category = one(sp.category).trim();
  const page = Number.parseInt(one(sp.page), 10);
  return {
    q: sanitizeSearchTerm(one(sp.q)),
    category: category && category.length <= 60 ? category : null,
    source: (SOURCES as readonly string[]).includes(source) ? (source as LibraryParams["source"]) : null,
    status: (STATUSES as readonly string[]).includes(status) ? (status as LibraryParams["status"]) : null,
    tag: /^[a-z0-9][a-z0-9 _-]{0,39}$/.test(tag) ? tag : null,
    format: CONTENT_FORMATS.some((f) => f.id === format) ? (format as ContentFormat) : "any",
    sort: sort in LIBRARY_SORTS ? (sort as LibrarySort) : "newest",
    page: Number.isFinite(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** Minimal shape of the PostgREST builder methods we use (keeps this testable). */
export interface FilterBuilder<T> {
  eq(column: string, value: unknown): T;
  or(filters: string): T;
  gte(column: string, value: unknown): T;
  lt(column: string, value: unknown): T;
  lte(column: string, value: unknown): T;
  order(column: string, opts: { ascending: boolean; nullsFirst?: boolean }): T;
  range(from: number, to: number): T;
}

export const LIBRARY_SELECT =
  "id, title, source_type, provider, url, author_name, thumbnail_url, thumbnail_path, duration_seconds, category, notes, media_status, analysis_status, created_at, reference_tags(tag)";

export function librarySelect(params: Pick<LibraryParams, "tag">) {
  // An inner join is only needed when filtering by tag.
  return params.tag ? LIBRARY_SELECT.replace("reference_tags(tag)", "reference_tags!inner(tag)") : LIBRARY_SELECT;
}

export function applyLibraryFilters<T extends FilterBuilder<T>>(query: T, p: LibraryParams, pageSize = LIBRARY_PAGE_SIZE): T {
  let q = query;
  if (p.q) {
    const term = `%${p.q}%`;
    q = q.or(`title.ilike.${term},description.ilike.${term},author_name.ilike.${term},notes.ilike.${term}`);
  }
  if (p.category) q = q.eq("category", p.category);
  if (p.source) q = q.eq("source_type", p.source);
  if (p.status) q = q.eq("analysis_status", p.status);
  if (p.tag) q = q.eq("reference_tags.tag", p.tag);
  if (p.format === "short") q = q.lt("duration_seconds", 240);
  if (p.format === "medium") q = q.gte("duration_seconds", 240).lte("duration_seconds", 1200);
  if (p.format === "long") q = q.gte("duration_seconds", 1200.001);
  const s = LIBRARY_SORTS[p.sort];
  q = q.order(s.column, { ascending: s.ascending, nullsFirst: false });
  const from = (p.page - 1) * pageSize;
  return q.range(from, from + pageSize - 1);
}

export interface LibraryRow {
  id: string;
  title: string;
  source_type: string;
  provider: string;
  url: string | null;
  author_name: string | null;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  duration_seconds: number | null;
  category: string | null;
  notes: string | null;
  media_status: string;
  analysis_status: string;
  created_at: string;
  reference_tags: { tag: string }[];
}

export function libraryRowToResult(r: LibraryRow & { description?: string | null }, retrievedAt: string): DiscoveryResult {
  return {
    provider: "library",
    externalId: r.id,
    url: r.url,
    title: r.title,
    description: r.description ?? null,
    authorName: r.author_name,
    thumbnailUrl: r.thumbnail_url,
    publishedAt: null,
    durationSeconds: r.duration_seconds === null ? null : Number(r.duration_seconds),
    metrics: {},
    retrievedAt,
    referenceId: r.id,
  };
}

/** Maps a discovery query onto library params (used by the library provider). */
export function discoveryToLibraryParams(q: DiscoveryQuery): LibraryParams {
  return {
    q: sanitizeSearchTerm([q.keywords, q.topic, q.niche, q.industry].filter(Boolean).join(" ")),
    category: q.category ?? null,
    source: null,
    status: null,
    tag: null,
    format: q.format,
    sort: "newest",
    page: 1,
  };
}
