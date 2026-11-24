import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Thumbnail } from "@/components/discover/reference-card";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatCompact, formatDate, formatDateTime, formatDuration } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { getProvider } from "@/server/discovery/registry";
import { SaveResultButton, SaveSearchForm } from "./search-actions";

export const metadata: Metadata = { title: "Search results" };

export default async function SearchResultsPage({ params }: { params: Promise<{ id: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: search } = await supabase.from("discovery_searches").select("*").eq("id", id).maybeSingle();
  if (!search) notFound();
  const { data: results, error } = await supabase.from("discovery_results").select("*").eq("search_id", id).order("position");
  if (error) throw new Error("Could not load results");

  const f = search.filters as Record<string, string>;
  const label = [search.query, f.topic, f.niche, f.industry].filter(Boolean).join(" · ") || "All library references";
  const groups = new Map<string, typeof results>();
  for (const r of results ?? []) groups.set(r.provider, [...(groups.get(r.provider) ?? []), r]);
  const errors = (search.errors ?? []) as { provider: string; status: string; message?: string }[];

  return (
    <>
      <PageHeader
        title={`Results for “${label}”`}
        description={<>{search.result_count} results · searched {formatDateTime(search.created_at)}{f.format && f.format !== "any" ? ` · format: ${f.format}` : ""}</>}
        actions={<ButtonLink href="/discover" variant="outline">New search</ButtonLink>}
      />
      <div className="mb-6"><SaveSearchForm searchId={search.id} savedName={search.is_saved ? search.name : null} /></div>

      {errors.map((e) => (
        <Alert key={e.provider} tone={e.status === "unavailable" ? "info" : "warning"} className="mb-3" title={`${getProvider(e.provider)?.name ?? e.provider}: ${e.status === "unavailable" ? "not available" : "failed"}`}>
          {e.message}
        </Alert>
      ))}

      {(results ?? []).length === 0 ? (
        <EmptyState title="No results" description="Try broader keywords, another format, or more sources." />
      ) : (
        [...groups.entries()].map(([provider, rows]) => (
          <section key={provider} className="mb-8" aria-labelledby={`p-${provider}`}>
            <h2 id={`p-${provider}`} className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
              {getProvider(provider)?.name ?? provider} <Badge>{rows!.length}</Badge>
            </h2>
            <Card className="divide-y divide-line">
              {rows!.map((r) => {
                const m = r.metrics as Record<string, number>;
                return (
                  <article key={r.id} className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center">
                    <div className="h-20 w-36 shrink-0 overflow-hidden rounded bg-surface-3"><Thumbnail src={r.thumbnail_url} alt="" /></div>
                    <div className="min-w-0 flex-1">
                      <h3 className="line-clamp-2 text-sm font-medium text-fg">{r.title}</h3>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {r.author_name ? `${r.author_name} · ` : ""}{r.duration_seconds !== null ? `${formatDuration(r.duration_seconds)} · ` : ""}
                        {r.published_at ? `published ${formatDate(r.published_at)} · ` : ""}
                        source: {getProvider(r.provider)?.name ?? r.provider} · retrieved {formatDateTime(r.retrieved_at)}
                      </p>
                      {Object.keys(m).length > 0 && (
                        <p className="mt-1 text-xs text-fg-muted">
                          {Object.entries(m).map(([k, v]) => `${formatCompact(v)} ${k}`).join(" · ")} <span className="text-fg-subtle">(as reported by the provider)</span>
                        </p>
                      )}
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {r.url && <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-xs text-fg-muted hover:text-fg">Open source ↗</a>}
                      {r.reference_id ? (
                        <Link href={`/discover/references/${r.reference_id}`} className="text-xs text-accent hover:text-accent-hover">In library →</Link>
                      ) : (
                        <SaveResultButton resultId={r.id} />
                      )}
                    </div>
                  </article>
                );
              })}
            </Card>
          </section>
        ))
      )}
    </>
  );
}
