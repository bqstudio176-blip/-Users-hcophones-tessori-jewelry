import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { EvidenceBadge, RuleStatusBadge } from "@/components/creative/badges";
import { RuleForm } from "@/components/creative/rule-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { setRuleOverride, setRuleStatus } from "@/server/actions/creative";
import { labelOf, OBJECTIVES, RULE_CATEGORIES_LABELS, SCRIPT_FORMATS } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Creative rule" };

function StatusButton({ id, status, label, variant = "outline" }: { id: string; status: string; label: string; variant?: "outline" | "primary" | "ghost" }) {
  return <form action={setRuleStatus}><input type="hidden" name="ruleId" value={id} /><input type="hidden" name="status" value={status} /><Button type="submit" size="sm" variant={variant}>{label}</Button></form>;
}

export default async function RuleDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string; error?: string; edit?: string }> }) {
  const ctx = await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: rule } = await supabase.from("creative_rules").select("*, creative_rule_tags(tag)").eq("id", id).maybeSingle();
  if (!rule) notFound();
  const [{ data: versions }, { data: override }] = await Promise.all([
    supabase.from("creative_rule_versions").select("id, version, change_note, created_at, snapshot").eq("rule_id", id).order("version", { ascending: false }),
    supabase.from("creative_rule_overrides").select("enabled").eq("workspace_id", ctx.workspace.id).eq("rule_id", id).maybeSingle(),
  ]);
  const isGlobal = rule.workspace_id === null;
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const canEdit = isGlobal ? Boolean(ctx.profile.is_platform_admin) : true;
  const enabledHere = isGlobal ? (override ? override.enabled : rule.status === "approved") : rule.status === "approved";
  const tags = (rule.creative_rule_tags as { tag: string }[]).map((t) => t.tag);

  return (
    <>
      <PageHeader
        title={rule.name}
        description={<><Link href="/script-lab/rules" className="text-accent">Creative rules</Link> · {RULE_CATEGORIES_LABELS[rule.category]} · v{rule.version} · <code className="text-xs">{rule.slug}</code></>}
        actions={<div className="flex flex-wrap items-center gap-2"><EvidenceBadge type={rule.evidence_type} /><RuleStatusBadge status={rule.status} />{isGlobal ? <Badge>Library</Badge> : <Badge tone="info">Workspace</Badge>}</div>}
      />
      {sp.saved && <Alert tone="success" className="mb-4">Rule saved.{!isGlobal && rule.status !== "approved" ? " It will be used by the agents once approved." : ""}</Alert>}
      {sp.error && <Alert tone="danger" className="mb-4">{sp.error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <Card>
            <CardContent className="space-y-4 pt-4 text-sm">
              <p className="text-fg">{rule.description}</p>
              <div><p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Objective</p><p className="text-fg-muted">{rule.objective}</p></div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div><p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Apply when</p><ul className="list-disc pl-4 text-fg-muted">{(rule.application_conditions as string[]).map((c, i) => <li key={i}>{c}</li>)}</ul></div>
                <div><p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Avoid when</p>{(rule.avoidance_conditions as string[]).length ? <ul className="list-disc pl-4 text-fg-muted">{(rule.avoidance_conditions as string[]).map((c, i) => <li key={i}>{c}</li>)}</ul> : <p className="text-fg-subtle">—</p>}</div>
              </div>
              <div><p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Example</p><p className="rounded-md bg-surface-2 p-3 text-fg-muted">{rule.example}</p></div>
              <div className="flex flex-wrap gap-1.5">
                {(rule.recommended_formats as string[]).map((f) => <Badge key={f}>{labelOf(SCRIPT_FORMATS, f)}</Badge>)}
                {(rule.objectives as string[]).map((o) => <Badge key={o} tone="info">{labelOf(OBJECTIVES, o)}</Badge>)}
                {tags.map((t) => <Link key={t} href={`/script-lab/rules?tag=${t}`} className="rounded-full border border-line px-2 py-0.5 text-[11px] text-fg-subtle hover:text-fg">#{t}</Link>)}
              </div>
              <div><p className="text-xs font-medium uppercase tracking-wide text-fg-subtle">Evidence</p><p className="text-fg-muted">{rule.evidence_note ?? (rule.evidence_type === "experimental" ? "Experimental — treat as a hypothesis to test." : "Practitioner heuristic — common craft guidance, not a measured effect.")}</p></div>
              <p className="text-xs text-fg-subtle">Complexity: {rule.complexity_level}{rule.min_duration_seconds || rule.max_duration_seconds ? ` · duration ${rule.min_duration_seconds ?? 0}–${rule.max_duration_seconds ?? "∞"}s` : ""}{rule.approved_at ? ` · approved ${formatDateTime(rule.approved_at)}` : ""}</p>
            </CardContent>
          </Card>

          {canEdit && (
            sp.edit ? (
              <Card><CardHeader><CardTitle>Edit rule</CardTitle></CardHeader><CardContent>
                <RuleForm values={{ id: rule.id, name: rule.name, category: rule.category, description: rule.description, objective: rule.objective, application_conditions: rule.application_conditions, avoidance_conditions: rule.avoidance_conditions, example: rule.example, recommended_formats: rule.recommended_formats, objectives: rule.objectives, complexity_level: rule.complexity_level, evidence_type: rule.evidence_type, evidence_note: rule.evidence_note, tags }} />
              </CardContent></Card>
            ) : <Link href="?edit=1" className="inline-block text-sm text-accent">Edit this rule →</Link>
          )}
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Availability</CardTitle><CardDescription>{enabledHere ? "Agents in this workspace can select this rule." : "Agents in this workspace will not select this rule."}</CardDescription></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {isGlobal && isAdmin && rule.status === "approved" && (
                <form action={setRuleOverride}><input type="hidden" name="ruleId" value={id} /><input type="hidden" name="enabled" value={enabledHere ? "false" : "true"} /><Button type="submit" size="sm" variant="outline">{enabledHere ? "Disable in this workspace" : "Enable in this workspace"}</Button></form>
              )}
              {isGlobal && ctx.profile.is_platform_admin && (rule.status === "approved" ? <StatusButton id={id} status="disabled" label="Disable globally" variant="ghost" /> : <StatusButton id={id} status="approved" label="Approve globally" />)}
              {!isGlobal && (
                <>
                  {(rule.status === "draft" || rule.status === "disabled") && <StatusButton id={id} status="pending_approval" label="Submit for approval" />}
                  {isAdmin && rule.status !== "approved" && <StatusButton id={id} status="approved" label="Approve" variant="primary" />}
                  {isAdmin && rule.status !== "disabled" && <StatusButton id={id} status="disabled" label="Disable" variant="ghost" />}
                  {!isAdmin && rule.status === "pending_approval" && <p className="text-xs text-fg-subtle">Waiting for an owner or admin to approve.</p>}
                </>
              )}
              {isGlobal && !isAdmin && <p className="text-xs text-fg-subtle">Owners and admins can turn library rules on or off for the workspace.</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Version history</CardTitle></CardHeader>
            <CardContent>
              <ol className="space-y-2 text-xs">
                <li className="text-fg">v{rule.version} — current</li>
                {(versions ?? []).map((v) => <li key={v.id} className="text-fg-muted">v{v.version} · {formatDateTime(v.created_at)}{v.change_note ? ` — ${v.change_note}` : ""}<details className="mt-1"><summary className="cursor-pointer text-fg-subtle">Snapshot</summary><p className="mt-1 whitespace-pre-wrap">{String((v.snapshot as { description?: string }).description ?? "")}</p></details></li>)}
              </ol>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
