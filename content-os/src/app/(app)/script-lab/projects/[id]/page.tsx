import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { EvidenceBadge, ProvenanceBadge } from "@/components/creative/badges";
import { FeedbackWidget } from "@/components/creative/feedback-widget";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime, formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { archiveProject, generateRecommendations, toggleIdeaFavorite } from "@/server/actions/creative";
import { IDEA_KINDS, labelOf, OBJECTIVES, RULE_CATEGORIES_LABELS, SCRIPT_FORMATS } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Creative project" };

type Prov = { type: string; source: string | null; detail: string; title?: string; reference_id?: string };

export default async function ProjectPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ strategy?: string; saved?: string; deleted?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: project } = await supabase.from("creative_projects").select("*").eq("id", id).maybeSingle();
  if (!project) notFound();
  const { data: strategies } = await supabase.from("content_strategies").select("id, name, objective, preferred_format, duration_seconds, updated_at, research_brief, recommendations, target_audience, main_topic").eq("project_id", id).order("updated_at", { ascending: false });
  const current = (strategies ?? []).find((s) => s.id === sp.strategy) ?? strategies?.[0];
  const [{ data: ideas }, { data: scripts }, { count: hookCount }] = await Promise.all([
    current ? supabase.from("generated_ideas").select("*").eq("strategy_id", current.id).order("created_at", { ascending: false }).limit(200) : Promise.resolve({ data: [] as never[] }),
    supabase.from("scripts").select("id, title, format, status, current_version, target_duration_seconds, updated_at, parent_script_id").eq("project_id", id).order("updated_at", { ascending: false }),
    supabase.from("generated_hooks").select("id", { count: "exact", head: true }).eq("project_id", id),
  ]);
  // Show only the latest generation run for the selected strategy.
  const latestRun = ideas?.[0]?.agent_run_id ?? null;
  const latestIdeas = (ideas ?? []).filter((i) => i.agent_run_id === latestRun);
  const recs = current?.recommendations as { generated_at?: string; rules?: { id: string; name: string; category: string; evidence_type: string; reasons: string[] }[] } | null;
  const brief = current?.research_brief as { summary: string; observed_patterns: { pattern: string; evidence: { source: string; detail: string }[] }[]; gaps: string[]; cautions: string[] } | null;
  const sources = (current?.recommendations as { sources?: Record<string, { title: string; reference_id: string }> } | null)?.sources ?? {};

  return (
    <>
      <PageHeader
        title={project.name}
        description={project.description ?? undefined}
        actions={
          <form action={archiveProject}>
            <input type="hidden" name="projectId" value={id} />
            <input type="hidden" name="status" value={project.status === "active" ? "archived" : "active"} />
            <Button type="submit" variant="ghost" size="sm">{project.status === "active" ? "Archive" : "Restore"}</Button>
          </form>
        }
      />
      {sp.saved && <Alert tone="success" className="mb-4">Strategy saved.</Alert>}
      {sp.deleted && <Alert tone="success" className="mb-4">Script deleted.</Alert>}

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Strategies</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {(strategies ?? []).length === 0 && <p className="text-xs text-fg-subtle">No strategy yet.</p>}
              {(strategies ?? []).map((s) => (
                <Link key={s.id} href={`/script-lab/projects/${id}?strategy=${s.id}`} aria-current={s.id === current?.id ? "true" : undefined} className={`block rounded-md px-2 py-1.5 text-sm ${s.id === current?.id ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2"}`}>
                  {s.name}
                  <span className="block text-[11px] text-fg-subtle">{labelOf(OBJECTIVES, s.objective)} · {labelOf(SCRIPT_FORMATS, s.preferred_format)}</span>
                </Link>
              ))}
              <ButtonLink href={`/script-lab/projects/${id}/strategy`} size="sm" variant="outline" className="w-full">New strategy</ButtonLink>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Production</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              <Link href={`/script-lab/projects/${id}/hooks${current ? `?strategy=${current.id}` : ""}`} className="flex justify-between text-fg hover:text-accent"><span>Hook generator</span><span className="text-fg-subtle">{hookCount ?? 0}</span></Link>
              <Link href={`/script-lab/projects/${id}/scripts/new${current ? `?strategy=${current.id}` : ""}`} className="flex justify-between text-fg hover:text-accent"><span>New script</span><span>→</span></Link>
            </CardContent>
          </Card>
        </aside>

        <div className="min-w-0 space-y-6">
          {!current ? (
            <EmptyState title="Build your first strategy" description="Define the audience, objective, format and references. The Strategy Agent then proposes opportunities, angles, hooks and CTAs with their reasoning." action={<ButtonLink href={`/script-lab/projects/${id}/strategy`} size="sm">Open strategy builder</ButtonLink>} />
          ) : (
            <>
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <CardTitle>{current.name}</CardTitle>
                      <CardDescription>{labelOf(OBJECTIVES, current.objective)} · {labelOf(SCRIPT_FORMATS, current.preferred_format)} · ~{current.duration_seconds}s{current.target_audience ? ` · for ${current.target_audience.slice(0, 60)}` : ""}</CardDescription>
                    </div>
                    <ButtonLink href={`/script-lab/projects/${id}/strategy?strategy=${current.id}`} variant="ghost" size="sm">Edit</ButtonLink>
                  </div>
                </CardHeader>
                <CardContent>
                  <ActionForm action={generateRecommendations} submitLabel={recs?.generated_at ? "Regenerate recommendations" : "Generate recommendations"} pendingLabel="Research and Strategy agents working…" className="space-y-2">
                    <input type="hidden" name="strategyId" value={current.id} />
                    <p className="text-xs text-fg-subtle">Runs the Research Agent (if analyzed references are attached, 1 credit) and the Strategy Agent (2 credits). Failed generations are free.{recs?.generated_at ? ` Last generated ${formatRelative(recs.generated_at)}.` : ""}</p>
                  </ActionForm>
                </CardContent>
              </Card>

              {brief && (
                <Card>
                  <CardHeader><CardTitle>Research brief</CardTitle><CardDescription>Patterns observed in your analyzed references, with sources.</CardDescription></CardHeader>
                  <CardContent className="space-y-3 text-sm">
                    <p className="text-fg">{brief.summary}</p>
                    {brief.observed_patterns.map((p) => (
                      <div key={p.pattern}>
                        <p className="font-medium text-fg">{p.pattern}</p>
                        <ul className="mt-1 space-y-1">{p.evidence.map((e, i) => <li key={i} className="flex gap-2 text-xs"><ProvenanceBadge type="observed">{sources[e.source]?.title ?? e.source}</ProvenanceBadge><span className="text-fg-muted">{e.detail}</span></li>)}</ul>
                      </div>
                    ))}
                    {brief.gaps.length > 0 && <p className="text-xs text-fg-muted"><span className="font-medium text-fg">Gaps:</span> {brief.gaps.join(" · ")}</p>}
                    {brief.cautions.length > 0 && <p className="text-xs text-fg-muted"><span className="font-medium text-fg">Cautions:</span> {brief.cautions.join(" · ")}</p>}
                  </CardContent>
                </Card>
              )}

              {latestIdeas.length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Recommendations</CardTitle><CardDescription>Each item shows its basis: observed facts, what you provided, or AI hypotheses to validate.</CardDescription></CardHeader>
                  <CardContent className="space-y-6">
                    {IDEA_KINDS.map((k) => {
                      const items = latestIdeas.filter((i) => i.kind === k.id);
                      if (!items.length) return null;
                      return (
                        <section key={k.id} aria-labelledby={`k-${k.id}`}>
                          <h3 id={`k-${k.id}`} className="mb-2 text-xs font-semibold uppercase tracking-wide text-fg-muted">{k.label}</h3>
                          <ul className="space-y-3">
                            {items.map((i) => (
                              <li key={i.id} className="rounded-md border border-line p-3">
                                <div className="flex items-start justify-between gap-2">
                                  <p className="font-medium text-fg">{i.title}</p>
                                  <form action={toggleIdeaFavorite}>
                                    <input type="hidden" name="ideaId" value={i.id} />
                                    <input type="hidden" name="favorite" value={String(!i.is_favorite)} />
                                    <button type="submit" aria-label={i.is_favorite ? "Remove from favorites" : "Save as favorite"} className="text-lg leading-none text-fg-subtle hover:text-warning">{i.is_favorite ? "★" : "☆"}</button>
                                  </form>
                                </div>
                                {i.body && <p className="mt-1 text-sm text-fg-muted">{i.body}</p>}
                                <p className="mt-2 text-xs text-fg"><span className="text-fg-subtle">Why:</span> {i.reasoning}</p>
                                <div className="mt-2 flex flex-wrap gap-1">{(i.provenance as Prov[]).map((p, n) => <ProvenanceBadge key={n} type={p.type}>{p.type === "observed" ? p.title ?? p.source : p.type === "user" ? p.source?.replace(/_/g, " ") : null}</ProvenanceBadge>)}</div>
                                <div className="mt-2"><FeedbackWidget targetType="recommendation" targetId={i.id} /></div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {recs?.rules && recs.rules.length > 0 && (
                <Card>
                  <CardHeader><CardTitle>Creative rules selected for this strategy</CardTitle><CardDescription>Chosen by the rule selection engine for this objective, format, duration and tone — not every rule applies.</CardDescription></CardHeader>
                  <CardContent>
                    <ul className="space-y-2">
                      {recs.rules.map((r) => (
                        <li key={r.id} className="flex flex-col gap-1 rounded-md border border-line p-2 text-sm sm:flex-row sm:items-start sm:justify-between">
                          <div className="min-w-0">
                            <Link href={`/script-lab/rules/${r.id}`} className="font-medium text-fg hover:text-accent">{r.name}</Link>
                            <p className="text-xs text-fg-muted">{r.reasons.join(" · ")}</p>
                          </div>
                          <div className="flex shrink-0 gap-1"><Badge>{RULE_CATEGORIES_LABELS[r.category] ?? r.category}</Badge><EvidenceBadge type={r.evidence_type} /></div>
                        </li>
                      ))}
                    </ul>
                  </CardContent>
                </Card>
              )}
            </>
          )}

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>Scripts</CardTitle>
                {current && <ButtonLink href={`/script-lab/projects/${id}/scripts/new?strategy=${current.id}`} size="sm">New script</ButtonLink>}
              </div>
            </CardHeader>
            <CardContent>
              {(scripts ?? []).length === 0 ? <p className="text-xs text-fg-subtle">No scripts yet.</p> : (
                <ul className="divide-y divide-line">
                  {(scripts ?? []).map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2 py-2">
                      <Link href={`/script-lab/scripts/${s.id}`} className="min-w-0 truncate text-sm text-fg hover:text-accent">{s.title}{s.parent_script_id && <span className="ml-1 text-xs text-fg-subtle">(alternative)</span>}</Link>
                      <span className="flex shrink-0 items-center gap-2 text-xs text-fg-subtle"><Badge tone={s.status === "approved" ? "success" : "neutral"} className="capitalize">{s.status}</Badge>v{s.current_version} · {formatDateTime(s.updated_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
