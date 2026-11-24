/** Shared vocabularies for Discover. */
export const REFERENCE_CATEGORIES = [
  "Education",
  "Entertainment",
  "Storytelling",
  "Tutorial",
  "Product",
  "Behind the scenes",
  "Testimonial",
  "Trend",
  "Lifestyle",
  "Other",
] as const;

export const CONTENT_FORMATS = [
  { id: "any", label: "Any format" },
  { id: "short", label: "Short-form (< 4 min)" },
  { id: "medium", label: "Medium (4–20 min)" },
  { id: "long", label: "Long-form (> 20 min)" },
] as const;
export type ContentFormat = (typeof CONTENT_FORMATS)[number]["id"];

export const SOURCE_LABELS: Record<string, string> = {
  upload: "Upload",
  instagram: "Instagram",
  youtube: "YouTube",
  web: "Web link",
};

export const ANALYSIS_STATUS_LABELS: Record<string, string> = {
  not_analyzed: "Not analyzed",
  queued: "Queued",
  processing: "Processing",
  analyzed: "Analyzed",
  failed: "Failed",
};

/** Lower-cases and validates tags to match the DB check constraint. */
export function normalizeTags(input: string): { tags: string[]; invalid: string[] } {
  const tags = new Set<string>();
  const invalid: string[] = [];
  for (const raw of input.split(",")) {
    const t = raw.trim().toLowerCase().replace(/\s+/g, " ");
    if (!t) continue;
    if (/^[a-z0-9][a-z0-9 _-]{0,39}$/.test(t)) tags.add(t);
    else invalid.push(raw.trim());
  }
  return { tags: [...tags].slice(0, 20), invalid };
}

/** Removes characters that are meaningful in PostgREST filter syntax. */
export function sanitizeSearchTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N}\s'._-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 100);
}
