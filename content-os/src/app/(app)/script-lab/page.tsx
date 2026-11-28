import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/creative/action-form";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/field";
import { EmptyState, PageHeader, Stat } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatNumber, formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { createProject } from "@/server/actions/creative";

export const metadata: Metadata = { title: "Script Lab" };

export default async function CreativeDashboard({ searchParams }: { searchParams: Promise<{ reference?: string }> }) {
  const ctx = await getWorkspaceContext();
  const { reference } = await searchParams;
  const supabase = await createClient();
  const ws = ctx.workspace.id;
  const [projects, scripts, hooks, analyzed, credits, pricing, runs] = await Promise.all([
    supabase.from("creative_projects").select("id, name, description, status, updated_at").eq("workspace_id", ws).order("updated_at", { ascending: false }).limit(30),
    supabase.from("scripts").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
    supabase.from("generated_hooks").select("id", { count: "exact", head: true }).eq("workspace_id", ws),
    supabase.from("content_references").select("id, title").eq("workspace_id", ws).eq("analysis_status", "analyzed").order("updated_at", { ascending: false }).limit(12),
    supabase.from("usage_credits").select("balance").eq("workspace_id", ws).maybeSingle(),
    supabase.from("ai_agent_pricing").select("agent, credits").order("credits"),
    supabase.from("ai_agent_runs").select("id, agent, status, credits_charged, created_at").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(5),
  ]);
  if (projects.error) throw new Error(projects.error.message);
  const aiConfigured = Boolean(process.env.ANTHROPIC_API_KEY);
  const active = (projects.data ?? []).filter((p) => p.status === "active");
  const archived = (projects.data ?? []).filter((p) => p.status === "archived");

  return (
    <>
      <PageHeader title="Creative intelligence" description="Turn analyzed references and your objectives into strategies, hooks and scripts — every recommendation shows what it is based on." />
      {!aiConfigured && (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-fg">
          AI generation is not configured on this deployment (ANTHROPIC_API_KEY). You can create projects, strategies, rules and edit scripts; generation buttons will report that AI is unavailable.
        </div>
      )}
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent><Stat label="Active projects" value={active.length} /></CardContent></Card>
        <Card><CardContent><Stat label="Scripts" value={scripts.count ?? 0} /></CardContent></Card>
        <Card><CardContent><Stat label="Hooks generated" value={hooks.count ?? 0} /></CardContent></Card>
        <Card><CardContent><Stat label="Credits available" value={formatNumber(credits.data?.balance ?? 0)} hint={(pricing.data ?? []).map((p) => `${p.agent.replace("_", " ")} ${p.credits}`).join(" · ")} /></CardContent></Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section aria-labelledby="projects-h">
          <h2 id="projects-h" className="mb-3 text-sm font-semibold text-fg">Projects</h2>
          {active.length === 0 ? (
            <EmptyState title="No creative projects yet" description="Create a project, then build a strategy from your analyzed references, topics or objectives." />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {active.map((p) => (
                <li key={p.id}>
                  <Link href={`/script-lab/projects/${p.id}`} className="block h-full rounded-lg border border-line bg-surface p-4 hover:border-line-strong">
                    <p className="font-medium text-fg">{p.name}</p>
                    {p.description && <p className="mt-1 line-clamp-2 text-xs text-fg-muted">{p.description}</p>}
                    <p className="mt-3 text-xs text-fg-subtle">Updated {formatRelative(p.updated_at)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {archived.length > 0 && <p className="mt-4 text-xs text-fg-subtle">{archived.length} archived project(s): {archived.map((p) => <Link key={p.id} href={`/script-lab/projects/${p.id}`} className="mr-2 underline">{p.name}</Link>)}</p>}

          <h2 className="mb-3 mt-8 text-sm font-semibold text-fg">Recent AI activity</h2>
          {(runs.data ?? []).length === 0 ? <p className="text-xs text-fg-subtle">No generations yet.</p> : (
            <ul className="space-y-1 text-sm">
              {(runs.data ?? []).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2">
                  <span className="capitalize text-fg">{r.agent.replace("_", " ")} agent</span>
                  <span className="flex items-center gap-2 text-xs text-fg-subtle">
                    <Badge tone={r.status === "succeeded" ? "success" : "danger"}>{r.status.replace("_", " ")}</Badge>
                    {r.credits_charged} cr · {formatRelative(r.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link href="/script-lab/usage" className="mt-2 inline-block text-xs text-accent hover:text-accent-hover">View AI usage</Link>
        </section>

        <Card>
          <CardHeader><CardTitle>New project</CardTitle><CardDescription>Start from analyzed references, topics or a business objective.</CardDescription></CardHeader>
          <CardContent>
            <ActionForm action={createProject} submitLabel="Create project" pendingLabel="Creating…">
              <Field label="Project name" name="name"><Input name="name" required maxLength={120} placeholder="Q1 budgeting series" /></Field>
              <Field label="Description" name="description"><Textarea name="description" maxLength={2000} className="min-h-16" /></Field>
              <fieldset>
                <legend className="mb-1 text-sm font-medium text-fg">Start from analyzed references (optional)</legend>
                {(analyzed.data ?? []).length === 0 ? (
                  <p className="text-xs text-fg-subtle">No analyzed references yet. <Link href="/analyze" className="underline">Analyze a video</Link> to ground strategies in research.</p>
                ) : (
                  <div className="max-h-48 space-y-1 overflow-y-auto">
                    {(analyzed.data ?? []).map((r) => (
                      <label key={r.id} className="flex items-center gap-2 text-sm text-fg">
                        <input type="checkbox" name="referenceIds" value={r.id} defaultChecked={r.id === reference} className="accent-[rgb(var(--color-accent))]" />
                        <span className="truncate">{r.title}</span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            </ActionForm>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
