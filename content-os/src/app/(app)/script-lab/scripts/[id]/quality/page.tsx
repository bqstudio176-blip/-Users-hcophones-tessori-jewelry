import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { FeedbackWidget } from "@/components/creative/feedback-widget";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { runQualityCheck } from "@/server/actions/creative";
import { labelOf, QUALITY_CRITERIA } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Quality report" };

type Report = {
  overall_assessment: string;
  criteria: { criterion: string; score: number; explanation: string }[];
  strengths: string[];
  weaknesses: { scene_number: number | null; issue: string; explanation: string }[];
  suggestions: { scene_number: number | null; suggestion: string; rationale: string }[];
};
type Checks = { duration?: { estimatedTotalSeconds: number; targetSeconds: number; toleranceSeconds: number; status: string }; originality?: { maxOverlapRatio: number } };

export default async function QualityPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ report?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: script } = await supabase.from("scripts").select("id, title, current_version").eq("id", id).maybeSingle();
  if (!script) notFound();
  const { data: reports } = await supabase.from("script_quality_reports").select("id, script_version, report, checks, created_at").eq("script_id", id).order("created_at", { ascending: false }).limit(20);
  const list = reports ?? [];
  const current = list.find((r) => r.id === sp.report) ?? list[0];
  const report = current?.report as Report | undefined;
  const checks = (current?.checks ?? {}) as Checks;

  return (
    <>
      <PageHeader
        title="Quality report"
        description={<><Link href={`/script-lab/scripts/${id}`} className="text-accent">{script.title}</Link> · current version {script.current_version}</>}
        actions={<ActionForm action={runQualityCheck} submitLabel="Run new check (1 credit)" pendingLabel="Quality Agent reviewing…" size="sm" variant="outline" className="flex items-center gap-2"><input type="hidden" name="scriptId" value={id} /></ActionForm>}
      />
      <Alert tone="info" className="mb-4">Scores are editorial heuristics produced by an AI reviewer against the strategy and best-practice rules. They are not predictions of views, reach or performance. The Quality Agent only recommends — it never changes your script.</Alert>
      {!current || !report ? (
        <EmptyState title="No quality report yet" description="Run a check to get scored criteria, strengths, weaknesses and suggestions." />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
          <div className="space-y-4">
            {current.script_version !== script.current_version && <Alert tone="warning">This report reviewed version {current.script_version}; the script is now at version {script.current_version}.</Alert>}
            <Card>
              <CardHeader><CardTitle>Overall assessment</CardTitle><CardDescription>Version {current.script_version} · {formatDateTime(current.created_at)}</CardDescription></CardHeader>
              <CardContent><p className="text-sm text-fg">{report.overall_assessment}</p></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Measured checks</CardTitle><CardDescription>Computed in code, not by AI.</CardDescription></CardHeader>
              <CardContent className="grid gap-3 text-sm sm:grid-cols-2">
                {checks.duration && <div><p className="text-xs text-fg-subtle">Estimated duration</p><p className="text-fg">{checks.duration.estimatedTotalSeconds}s vs target {checks.duration.targetSeconds}s ±{checks.duration.toleranceSeconds}s <Badge tone={checks.duration.status === "within_target" ? "success" : "warning"}>{checks.duration.status.replace("_", " ")}</Badge></p></div>}
                {checks.originality && <div><p className="text-xs text-fg-subtle">Overlap with reference transcripts</p><p className="text-fg">{Math.round(checks.originality.maxOverlapRatio * 100)}% <span className="text-xs text-fg-subtle">(limit 15%)</span></p></div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle>Criteria (1–5, heuristic)</CardTitle></CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {report.criteria.map((c) => (
                    <li key={c.criterion}>
                      <div className="flex items-center justify-between text-sm"><span className="font-medium text-fg">{labelOf(QUALITY_CRITERIA, c.criterion)}</span><span className="tabular-nums text-fg">{c.score}/5</span></div>
                      <div className="mt-1 h-1.5 rounded-full bg-surface-3"><div className="h-1.5 rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(5, c.score)) * 20}%` }} /></div>
                      <p className="mt-1 text-xs text-fg-muted">{c.explanation}</p>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
            <div className="grid gap-4 md:grid-cols-2">
              <Card><CardHeader><CardTitle>Strengths</CardTitle></CardHeader><CardContent><ul className="list-disc space-y-1 pl-4 text-sm text-fg-muted">{report.strengths.map((s, i) => <li key={i}>{s}</li>)}</ul></CardContent></Card>
              <Card><CardHeader><CardTitle>Weaknesses</CardTitle></CardHeader><CardContent><ul className="space-y-2 text-sm">{report.weaknesses.map((w, i) => <li key={i}><span className="text-fg">{w.scene_number ? `Scene ${w.scene_number}: ` : ""}{w.issue}</span><p className="text-xs text-fg-muted">{w.explanation}</p></li>)}</ul></CardContent></Card>
            </div>
            <Card>
              <CardHeader><CardTitle>Suggestions</CardTitle><CardDescription>Apply any of these yourself in the editor, or with the AI tools (which create a proposal you confirm).</CardDescription></CardHeader>
              <CardContent><ul className="space-y-2 text-sm">{report.suggestions.map((s, i) => <li key={i}><span className="text-fg">{s.scene_number ? `Scene ${s.scene_number}: ` : ""}{s.suggestion}</span><p className="text-xs text-fg-muted">{s.rationale}</p></li>)}</ul></CardContent>
            </Card>
            <Card><CardContent className="pt-4"><FeedbackWidget targetType="quality_report" targetId={current.id} targetVersion={current.script_version} /></CardContent></Card>
          </div>
          <aside>
            <h2 className="mb-2 text-sm font-semibold text-fg">Report history</h2>
            <ul className="space-y-1">
              {list.map((r) => <li key={r.id}><Link href={`?report=${r.id}`} className={`block rounded-md px-2 py-1.5 text-xs ${r.id === current.id ? "bg-surface-2 text-fg" : "text-fg-muted hover:bg-surface-2"}`}>v{r.script_version} · {formatDateTime(r.created_at)}</Link></li>)}
            </ul>
          </aside>
        </div>
      )}
    </>
  );
}
