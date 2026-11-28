import type { Metadata } from "next";
import Link from "next/link";
import { ReferenceCard, type ReferenceCardData } from "@/components/discover/reference-card";
import { Alert } from "@/components/ui/alert";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { ANALYSIS_STATUS_LABELS, CONTENT_FORMATS, REFERENCE_CATEGORIES, SOURCE_LABELS } from "@/lib/discover/catalog";
import { createClient } from "@/lib/supabase/server";
import { applyLibraryFilters, LIBRARY_PAGE_SIZE, LIBRARY_SORTS, librarySelect, parseLibraryParams } from "@/server/discovery/library";
import { signMediaUrls } from "@/server/media-urls";

export const metadata: Metadata = { title: "Reference library" };

export default async function LibraryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await getWorkspaceContext();
  const sp = await searchParams;
  const p = parseLibraryParams(sp);
  const supabase = await createClient();
  const base = supabase.from("content_references").select(librarySelect(p), { count: "exact" }).eq("workspace_id", ctx.workspace.id);
  const { data, count, error } = await applyLibraryFilters(base, p);
  if (error) throw new Error(`Could not load library: ${error.message}`);
  const rows = (data ?? []) as unknown as ReferenceCardData[];
  const thumbs = await signMediaUrls(rows.map((r) => r.thumbnail_path));
  const total = count ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIBRARY_PAGE_SIZE));
  const filtered = Boolean(p.q || p.category || p.source || p.status || p.tag || p.format !== "any");

  const pageHref = (page: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries({ q: p.q, category: p.category, source: p.source, status: p.status, tag: p.tag, format: p.format === "any" ? null : p.format, sort: p.sort === "newest" ? null : p.sort })) if (v) qs.set(k, v);
    if (page > 1) qs.set("page", String(page));
    return `/discover/library${qs.size ? `?${qs}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Reference library" description={`${total} reference${total === 1 ? "" : "s"}${filtered ? " match your filters" : " in this workspace"}.`} actions={<ButtonLink href="/discover/import">Import</ButtonLink>} />
      {sp.deleted && <Alert tone="success" className="mb-4">Reference deleted.</Alert>}

      <form method="get" className="mb-6 grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2 lg:grid-cols-7" role="search" aria-label="Filter library">
        <div className="lg:col-span-2">
          <label htmlFor="q" className="sr-only">Search</label>
          <Input name="q" defaultValue={p.q} placeholder="Search title, author, notes…" />
        </div>
        <label className="sr-only" htmlFor="category">Category</label>
        <Select name="category" defaultValue={p.category ?? ""}><option value="">All categories</option>{REFERENCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        <label className="sr-only" htmlFor="source">Source</label>
        <Select name="source" defaultValue={p.source ?? ""}><option value="">All sources</option>{Object.entries(SOURCE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <label className="sr-only" htmlFor="status">Analysis status</label>
        <Select name="status" defaultValue={p.status ?? ""}><option value="">Any status</option>{Object.entries(ANALYSIS_STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <label className="sr-only" htmlFor="format">Format</label>
        <Select name="format" defaultValue={p.format}>{CONTENT_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select>
        <label className="sr-only" htmlFor="sort">Sort</label>
        <Select name="sort" defaultValue={p.sort}>{Object.entries(LIBRARY_SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</Select>
        <div className="flex gap-2 lg:col-span-7">
          <label className="sr-only" htmlFor="tag">Tag</label>
          <Input name="tag" defaultValue={p.tag ?? ""} placeholder="Tag" className="max-w-40" />
          <Button type="submit" variant="secondary">Apply</Button>
          {filtered && <ButtonLink href="/discover/library" variant="ghost">Clear</ButtonLink>}
        </div>
      </form>

      {rows.length === 0 ? (
        filtered ? (
          <EmptyState title="No references match" description="Try removing a filter." action={<ButtonLink href="/discover/library" size="sm" variant="outline">Clear filters</ButtonLink>} />
        ) : (
          <EmptyState title="Your library is empty" description="Import references from Instagram or YouTube, or upload your own videos." action={<ButtonLink href="/discover/import" size="sm">Import reference</ButtonLink>} />
        )
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {rows.map((r) => <ReferenceCard key={r.id} r={r} thumbnail={r.thumbnail_path ? thumbs[r.thumbnail_path] ?? null : r.thumbnail_url} />)}
        </div>
      )}

      {pages > 1 && (
        <nav aria-label="Pagination" className="mt-6 flex items-center justify-between text-sm">
          {p.page > 1 ? <Link href={pageHref(p.page - 1)} className="text-accent hover:text-accent-hover">← Previous</Link> : <span />}
          <span className="text-fg-muted">Page {p.page} of {pages}</span>
          {p.page < pages ? <Link href={pageHref(p.page + 1)} className="text-accent hover:text-accent-hover">Next →</Link> : <span />}
        </nav>
      )}
    </>
  );
}
