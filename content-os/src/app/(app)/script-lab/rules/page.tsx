import type { Metadata } from "next";
import Link from "next/link";
import { EvidenceBadge, RuleStatusBadge } from "@/components/creative/badges";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { labelOf, RULE_CATEGORIES_LABELS, SCRIPT_FORMATS } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Creative rules" };

const sel = "h-9 rounded-md border border-line bg-surface-2 px-2 text-sm text-fg";

export default async function RulesPage({ searchParams }: { searchParams: Promise<{ q?: string; category?: string; evidence?: string; format?: string; status?: string; scope?: string; tag?: string }> }) {
  const ctx = await getWorkspaceContext();
  const sp = await searchParams;
  const supabase = await createClient();
  let query = supabase.from("creative_rules")
    .select("id, slug, name, category, description, evidence_type, complexity_level, status, version, workspace_id, recommended_formats, creative_rule_tags(tag)")
    .or(`workspace_id.is.null,workspace_id.eq.${ctx.workspace.id}`)
    .order("category").order("name").limit(300);
  if (sp.category && sp.category in RULE_CATEGORIES_LABELS) query = query.eq("category", sp.category);
  if (sp.evidence && ["established_principle", "practitioner_heuristic", "experimental"].includes(sp.evidence)) query = query.eq("evidence_type", sp.evidence);
  if (sp.status && ["draft", "pending_approval", "approved", "disabled"].includes(sp.status)) query = query.eq("status", sp.status);
  if (sp.format && SCRIPT_FORMATS.some((f) => f.id === sp.format)) query = query.contains("recommended_formats", [sp.format]);
  if (sp.scope === "workspace") query = query.not("workspace_id", "is", null);
  if (sp.scope === "library") query = query.is("workspace_id", null);
  const q = (sp.q ?? "").trim().slice(0, 80).replace(/[%,()*\\]/g, " ");
  if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%,slug.ilike.%${q}%`);
  const [{ data: rules }, { data: overrides }] = await Promise.all([
    query,
    supabase.from("creative_rule_overrides").select("rule_id, enabled").eq("workspace_id", ctx.workspace.id),
  ]);
  const off = new Set((overrides ?? []).filter((o) => !o.enabled).map((o) => o.rule_id));
  const tag = (sp.tag ?? "").toLowerCase();
  const list = (rules ?? []).filter((r) => !tag || (r.creative_rule_tags as { tag: string }[]).some((t) => t.tag === tag));

  return (
    <>
      <PageHeader title="Creative rules" description="Original, documented guidelines the agents select from. Each pick is explained; rules guide the work, they don't guarantee results." actions={<ButtonLink href="/script-lab/rules/new" size="sm">New workspace rule</ButtonLink>} />
      <form className="mb-4 flex flex-wrap gap-2" role="search">
        <label htmlFor="q" className="sr-only">Search rules</label>
        <input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="Search rules…" className={`${sel} min-w-56 flex-1`} />
        <select name="category" defaultValue={sp.category ?? ""} className={sel} aria-label="Category"><option value="">All categories</option>{Object.entries(RULE_CATEGORIES_LABELS).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</select>
        <select name="evidence" defaultValue={sp.evidence ?? ""} className={sel} aria-label="Evidence"><option value="">Any evidence</option><option value="established_principle">Established principle</option><option value="practitioner_heuristic">Practitioner heuristic</option><option value="experimental">Experimental</option></select>
        <select name="format" defaultValue={sp.format ?? ""} className={sel} aria-label="Format"><option value="">Any format</option>{SCRIPT_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
        <select name="status" defaultValue={sp.status ?? ""} className={sel} aria-label="Status"><option value="">Any status</option><option value="approved">Approved</option><option value="pending_approval">Pending approval</option><option value="draft">Draft</option><option value="disabled">Disabled</option></select>
        <select name="scope" defaultValue={sp.scope ?? ""} className={sel} aria-label="Scope"><option value="">Library + workspace</option><option value="library">Library only</option><option value="workspace">Workspace only</option></select>
        <input name="tag" defaultValue={sp.tag ?? ""} placeholder="tag" className={`${sel} w-28`} aria-label="Tag" />
        <button type="submit" className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">Filter</button>
      </form>
      <p className="mb-3 text-xs text-fg-subtle">{list.length} rule{list.length === 1 ? "" : "s"}</p>
      {list.length === 0 ? <EmptyState title="No rules match" description="Try clearing a filter." /> : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((r) => (
            <li key={r.id}>
              <Link href={`/script-lab/rules/${r.id}`} className={`block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent/50 ${off.has(r.id) ? "opacity-60" : ""}`}>
                <div className="mb-2 flex flex-wrap items-center gap-1.5">
                  <Badge>{RULE_CATEGORIES_LABELS[r.category] ?? r.category}</Badge>
                  <EvidenceBadge type={r.evidence_type} />
                  {r.workspace_id ? <RuleStatusBadge status={r.status} /> : r.status === "disabled" ? <RuleStatusBadge status="disabled" /> : null}
                  {off.has(r.id) && <Badge tone="warning">Off in workspace</Badge>}
                  {r.workspace_id && <Badge tone="info">Workspace</Badge>}
                </div>
                <p className="font-medium text-fg">{r.name}</p>
                <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{r.description}</p>
                <p className="mt-2 text-[11px] text-fg-subtle">v{r.version} · {r.complexity_level} · {(r.recommended_formats as string[]).slice(0, 3).map((f) => labelOf(SCRIPT_FORMATS, f)).join(", ")}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
