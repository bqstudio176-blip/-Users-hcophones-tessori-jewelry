import type { Metadata } from "next";
import Link from "next/link";
import { ReferenceCard, Thumbnail, type ReferenceCardData } from "@/components/discover/reference-card";
import { SearchForm } from "@/components/discover/search-form";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatCompact, formatDuration, formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { providerAvailability, providerContext } from "@/server/discovery/availability";
import { LIBRARY_SELECT } from "@/server/discovery/library";
import { youtubeProvider } from "@/server/discovery/providers/youtube";
import type { DiscoveryResult } from "@/server/discovery/types";
import { signMediaUrls } from "@/server/media-urls";
import { DeleteSearchButton } from "./search/[id]/search-actions";

export const metadata: Metadata = { title: "Discover" };

export default async function DiscoverPage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const ws = ctx.workspace.id;

  const [providers, recent, analyzed, saved, history, settings] = await Promise.all([
    providerAvailability(ws),
    supabase.from("content_references").select(LIBRARY_SELECT).eq("workspace_id", ws).order("created_at", { ascending: false }).limit(4),
    supabase.from("content_references").select(LIBRARY_SELECT).eq("workspace_id", ws).eq("analysis_status", "analyzed").order("updated_at", { ascending: false }).limit(4),
    supabase.from("discovery_searches").select("id, name, query, filters, providers, result_count, created_at").eq("workspace_id", ws).eq("is_saved", true).order("created_at", { ascending: false }).limit(8),
    supabase.from("discovery_searches").select("id, query, filters, providers, result_count, status, created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(8),
    supabase.from("workspace_settings").select("content_niche").eq("workspace_id", ws).maybeSingle(),
  ]);
  for (const r of [recent, analyzed, saved, history]) if (r.error) throw new Error(`Discover query failed: ${r.error.message}`);

  // Trending only when an authorized provider supports it (YouTube most-popular chart).
  let trending: DiscoveryResult[] = [];
  let trendingError: string | null = null;
  const yt = providers.find((p) => p.provider.id === "youtube");
  if (yt?.availability.available) {
    try {
      trending = await youtubeProvider.trending!(providerContext(ws), { regionCode: process.env.DISCOVER_TRENDING_REGION ?? "US", limit: 8 });
    } catch (e) {
      trendingError = e instanceof Error ? e.message : "Unavailable";
    }
  }

  const recentRows = (recent.data ?? []) as unknown as ReferenceCardData[];
  const analyzedRows = (analyzed.data ?? []) as unknown as ReferenceCardData[];
  const thumbs = await signMediaUrls([...recentRows, ...analyzedRows].map((r) => r.thumbnail_path));
  const thumbFor = (r: ReferenceCardData) => (r.thumbnail_path ? thumbs[r.thumbnail_path] ?? null : r.thumbnail_url);

  return (
    <>
      <PageHeader title="Discover" description="Research, import and organize content references for this workspace." actions={<ButtonLink href="/discover/import">Import reference</ButtonLink>} />

      <Card>
        <CardContent className="pt-5">
          <SearchForm
            providers={providers.map(({ provider, availability }) => ({ id: provider.id, name: provider.name, available: availability.available, reason: availability.available ? undefined : availability.reason }))}
            defaults={{ niche: settings.data?.content_niche ?? undefined }}
          />
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <section aria-labelledby="recent-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="recent-h" className="text-sm font-semibold text-fg">Recently added</h2>
              <Link href="/discover/library" className="text-xs text-accent hover:text-accent-hover">Open library</Link>
            </div>
            {recentRows.length === 0 ? (
              <EmptyState title="Your library is empty" description="Import an Instagram Reel or YouTube link, or upload a video to start building your research library." action={<ButtonLink href="/discover/import" size="sm">Import your first reference</ButtonLink>} />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{recentRows.map((r) => <ReferenceCard key={r.id} r={r} thumbnail={thumbFor(r)} />)}</div>
            )}
          </section>

          <section aria-labelledby="analyzed-h">
            <div className="mb-3 flex items-center justify-between">
              <h2 id="analyzed-h" className="text-sm font-semibold text-fg">Recently analyzed</h2>
              <Link href="/analyze" className="text-xs text-accent hover:text-accent-hover">All analyses</Link>
            </div>
            {analyzedRows.length === 0 ? (
              <EmptyState title="No analyses yet" description="Open a reference with an uploaded video and run an analysis." />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{analyzedRows.map((r) => <ReferenceCard key={r.id} r={r} thumbnail={thumbFor(r)} />)}</div>
            )}
          </section>

          <section aria-labelledby="trending-h">
            <h2 id="trending-h" className="mb-1 text-sm font-semibold text-fg">Trending</h2>
            {!yt?.availability.available ? (
              <EmptyState title="Trending is not available" description="Trending requires an authorized data source. Configure the YouTube Data API to see the most-popular chart." action={<ButtonLink href="/discover/sources" size="sm" variant="outline">View sources</ButtonLink>} />
            ) : trendingError ? (
              <EmptyState title="Trending could not be loaded" description={trendingError} />
            ) : (
              <>
                <p className="mb-3 text-xs text-fg-subtle">YouTube most-popular chart · retrieved {formatRelative(trending[0]?.retrievedAt ?? new Date())}</p>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {trending.map((t) => (
                    <li key={t.externalId}>
                      <a href={t.url ?? "#"} target="_blank" rel="noopener noreferrer" className="flex gap-3 rounded-md border border-line p-2 hover:border-line-strong">
                        <span className="h-16 w-28 shrink-0 overflow-hidden rounded bg-surface-3"><Thumbnail src={t.thumbnailUrl} alt="" /></span>
                        <span className="min-w-0">
                          <span className="line-clamp-2 text-sm text-fg">{t.title}</span>
                          <span className="text-xs text-fg-subtle">{t.authorName} · {formatDuration(t.durationSeconds)}{t.metrics.views !== undefined ? ` · ${formatCompact(t.metrics.views)} views` : ""}</span>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Saved searches</CardTitle><CardDescription>Re-open research you want to revisit.</CardDescription></CardHeader>
            <CardContent>
              {(saved.data ?? []).length === 0 ? <p className="text-xs text-fg-subtle">Save a search from its results page.</p> : (
                <ul className="space-y-2">
                  {(saved.data ?? []).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <Link href={`/discover/search/${s.id}`} className="min-w-0 truncate text-sm text-fg hover:text-accent">{s.name}</Link>
                      <span className="shrink-0 text-xs text-fg-subtle">{s.result_count} results</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Research history</CardTitle></CardHeader>
            <CardContent>
              {(history.data ?? []).length === 0 ? <p className="text-xs text-fg-subtle">Your searches will appear here.</p> : (
                <ul className="space-y-3">
                  {(history.data ?? []).map((s) => {
                    const f = s.filters as Record<string, string>;
                    const label = [s.query, f.topic, f.niche, f.industry].filter(Boolean).join(" · ") || "All library references";
                    return (
                      <li key={s.id} className="flex items-start justify-between gap-2">
                        <Link href={`/discover/search/${s.id}`} className="min-w-0">
                          <span className="block truncate text-sm text-fg hover:text-accent">{label}</span>
                          <span className="text-xs text-fg-subtle">{s.result_count} results · {(s.providers as string[]).join(", ")} · {formatRelative(s.created_at)}</span>
                        </Link>
                        {s.status !== "completed" && <Badge tone={s.status === "failed" ? "danger" : "warning"}>{s.status}</Badge>}
                        <DeleteSearchButton searchId={s.id} />
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
