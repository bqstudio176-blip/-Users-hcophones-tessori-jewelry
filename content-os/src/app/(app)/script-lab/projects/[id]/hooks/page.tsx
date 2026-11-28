import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { FeedbackWidget } from "@/components/creative/feedback-widget";
import { HookEditForm } from "@/components/creative/hook-edit-form";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { deleteHook, generateHooksAction, toggleHookFavorite } from "@/server/actions/creative";
import { HOOK_CATEGORIES, labelOf } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Hook generator" };

export default async function HookGeneratorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ strategy?: string; compare?: string; favorites?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: project } = await supabase.from("creative_projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) notFound();
  const { data: strategies } = await supabase.from("content_strategies").select("id, name").eq("project_id", id).order("updated_at", { ascending: false });
  const strategyId = (strategies ?? []).find((s) => s.id === sp.strategy)?.id ?? strategies?.[0]?.id;
  let q = supabase.from("generated_hooks").select("*").eq("project_id", id).order("created_at", { ascending: false }).limit(100);
  if (sp.favorites) q = q.eq("is_favorite", true);
  const { data: hooks } = await q;
  const compareIds = (sp.compare ?? "").split(",").filter((x) => uuidSchema.safeParse(x).success);
  const compared = (hooks ?? []).filter((h) => compareIds.includes(h.id));
  const ruleIds = [...new Set((hooks ?? []).flatMap((h) => h.rule_ids as string[]))];
  const { data: rules } = ruleIds.length ? await supabase.from("creative_rules").select("id, name").in("id", ruleIds) : { data: [] };
  const ruleName = new Map((rules ?? []).map((r) => [r.id, r.name]));
  const toggleCompare = (hid: string) => {
    const set = new Set(compareIds);
    if (set.has(hid)) set.delete(hid);
    else set.add(hid);
    const qs = new URLSearchParams({ ...(strategyId ? { strategy: strategyId } : {}), ...(set.size ? { compare: [...set].join(",") } : {}), ...(sp.favorites ? { favorites: "1" } : {}) });
    return `/script-lab/projects/${id}/hooks?${qs}`;
  };

  return (
    <>
      <PageHeader title="Hook generator" description={<>Project: <Link href={`/script-lab/projects/${id}`} className="text-accent">{project.name}</Link>. Hooks are openings to test — no hook is guaranteed to perform.</>} />
      <div className="grid gap-6 lg:grid-cols-[22rem_1fr]">
        <Card className="self-start">
          <CardHeader><CardTitle>Generate hooks</CardTitle><CardDescription>2 credits per batch. Uses your strategy, research and selected rules.</CardDescription></CardHeader>
          <CardContent>
            {!strategyId ? (
              <EmptyState title="Create a strategy first" action={<ButtonLink href={`/script-lab/projects/${id}/strategy`} size="sm">Strategy builder</ButtonLink>} />
            ) : (
              <ActionForm action={generateHooksAction} submitLabel="Generate hooks" pendingLabel="Hook Agent writing…">
                <Field label="Strategy" name="strategyId">
                  <Select name="strategyId" defaultValue={strategyId}>{(strategies ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
                </Field>
                <fieldset>
                  <legend className="mb-1 text-sm font-medium text-fg">Approaches</legend>
                  <div className="flex flex-wrap gap-1.5">
                    {HOOK_CATEGORIES.map((c, i) => (
                      <label key={c.id} className="cursor-pointer rounded-full border border-line px-2.5 py-1 text-xs has-[:checked]:border-accent has-[:checked]:bg-accent/10">
                        <input type="checkbox" name="categories" value={c.id} defaultChecked={i < 4} className="sr-only" /> {c.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Field label="How many" name="count"><Input name="count" type="number" min={1} max={10} defaultValue={5} /></Field>
                <Field label="Extra instructions (optional)" name="instructions"><Textarea name="instructions" maxLength={1000} className="min-h-16" /></Field>
              </ActionForm>
            )}
          </CardContent>
        </Card>

        <div className="min-w-0 space-y-4">
          {compared.length >= 2 && (
            <Card>
              <CardHeader><CardTitle>Compare variations</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-fg-subtle"><tr><th scope="col" className="pb-2 pr-4">Hook</th><th scope="col" className="pb-2 pr-4">Approach</th><th scope="col" className="pb-2 pr-4">Mechanism</th><th scope="col" className="pb-2 pr-4">Visual opening</th><th scope="col" className="pb-2">Est. duration</th></tr></thead>
                  <tbody className="divide-y divide-line">
                    {compared.map((h) => <tr key={h.id} className="align-top"><td className="py-2 pr-4 text-fg">“{h.text}”</td><td className="py-2 pr-4">{labelOf(HOOK_CATEGORIES, h.category)}</td><td className="py-2 pr-4 text-fg-muted">{h.mechanism}</td><td className="py-2 pr-4 text-fg-muted">{h.visual_opening}</td><td className="py-2 tabular-nums">{Number(h.estimated_duration_seconds)}s</td></tr>)}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-fg">{sp.favorites ? "Favorite hooks" : "All hooks"} ({hooks?.length ?? 0})</h2>
            <Link href={sp.favorites ? `/script-lab/projects/${id}/hooks` : `/script-lab/projects/${id}/hooks?favorites=1`} className="text-xs text-accent hover:text-accent-hover">{sp.favorites ? "Show all" : "Show favorites"}</Link>
          </div>
          {(hooks ?? []).length === 0 ? <EmptyState title="No hooks yet" description="Choose approaches and generate a batch." /> : (
            <ul className="space-y-3">
              {(hooks ?? []).map((h) => (
                <li key={h.id}>
                  <Card>
                    <CardContent className="space-y-3 pt-4">
                      <HookEditForm hookId={h.id} text={h.text} original={h.original_text} />
                      <div className="flex flex-wrap gap-1.5"><Badge tone="accent">{labelOf(HOOK_CATEGORIES, h.category)}</Badge><Badge>~{Number(h.estimated_duration_seconds)}s (estimate)</Badge>{h.text !== h.original_text && <Badge tone="info">Edited</Badge>}</div>
                      <dl className="grid gap-2 text-sm sm:grid-cols-2">
                        <div><dt className="text-xs text-fg-subtle">Psychological mechanism</dt><dd className="text-fg">{h.mechanism}</dd></div>
                        <div><dt className="text-xs text-fg-subtle">Suggested visual opening</dt><dd className="text-fg">{h.visual_opening}</dd></div>
                        <div><dt className="text-xs text-fg-subtle">Delivery</dt><dd className="text-fg">{h.delivery}</dd></div>
                        <div><dt className="text-xs text-fg-subtle">Rationale (AI)</dt><dd className="text-fg">{h.rationale}</dd></div>
                      </dl>
                      {(h.rule_ids as string[]).length > 0 && <p className="text-xs text-fg-muted">Rules applied: {(h.rule_ids as string[]).map((r) => <Link key={r} href={`/script-lab/rules/${r}`} className="mr-2 underline">{ruleName.get(r) ?? "rule"}</Link>)}</p>}
                      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
                        <ButtonLink href={`/script-lab/projects/${id}/scripts/new?strategy=${h.strategy_id ?? strategyId ?? ""}&hook=${h.id}`} size="sm">Use in Script Lab</ButtonLink>
                        <form action={toggleHookFavorite}><input type="hidden" name="hookId" value={h.id} /><input type="hidden" name="favorite" value={String(!h.is_favorite)} /><button type="submit" className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2">{h.is_favorite ? "★ Favorite" : "☆ Save favorite"}</button></form>
                        <Link href={toggleCompare(h.id)} className="rounded px-2 py-1 text-xs text-fg-muted hover:bg-surface-2">{compareIds.includes(h.id) ? "Remove from compare" : "Compare"}</Link>
                        <form action={deleteHook}><input type="hidden" name="hookId" value={h.id} /><button type="submit" className="rounded px-2 py-1 text-xs text-danger hover:bg-surface-2">Delete</button></form>
                        <div className="ml-auto"><FeedbackWidget targetType="hook" targetId={h.id} /></div>
                      </div>
                    </CardContent>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
