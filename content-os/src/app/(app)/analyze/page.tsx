import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime, formatDuration } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Analyze" };

const TONE = { completed: "success", failed: "danger", canceled: "neutral", queued: "info", processing: "info" } as const;

export default async function AnalyzePage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const [{ data: analyses, error }, { data: ready }, { data: cost }] = await Promise.all([
    supabase
      .from("video_analyses")
      .select("id, status, created_at, completed_at, error, transcript_status, reference:content_references(id, title, duration_seconds)")
      .eq("workspace_id", ctx.workspace.id)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("content_references")
      .select("id, title, duration_seconds, analysis_status")
      .eq("workspace_id", ctx.workspace.id)
      .eq("media_status", "uploaded")
      .in("analysis_status", ["not_analyzed", "failed"])
      .order("created_at", { ascending: false })
      .limit(6),
    supabase.rpc("analysis_credit_cost"),
  ]);
  if (error) throw new Error(`Could not load analyses: ${error.message}`);

  return (
    <>
      <PageHeader title="Analyze" description={`AI breakdowns of your references. Each analysis uses ${Number(cost ?? 5)} credits; failed or cancelled analyses are refunded.`} actions={<ButtonLink href="/discover/import?tab=upload">Upload a video</ButtonLink>} />

      {(ready ?? []).length > 0 && (
        <Card className="mb-6">
          <CardHeader><CardTitle>Ready to analyze</CardTitle><CardDescription>References with an uploaded video and no completed analysis.</CardDescription></CardHeader>
          <CardContent>
            <ul className="divide-y divide-line">
              {(ready ?? []).map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <span className="min-w-0 truncate text-sm text-fg">{r.title} <span className="text-xs text-fg-subtle">· {formatDuration(r.duration_seconds)}</span></span>
                  <Link href={`/discover/references/${r.id}`} className="shrink-0 text-xs text-accent hover:text-accent-hover">Open to analyze →</Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {(analyses ?? []).length === 0 ? (
        <EmptyState title="No analyses yet" description="Upload a video (or add a video file to an imported reference), then start an analysis from the reference page." action={<ButtonLink href="/discover/import?tab=upload" size="sm">Upload a video</ButtonLink>} />
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-fg-subtle">
              <tr><th scope="col" className="px-4 py-3 font-medium">Reference</th><th scope="col" className="px-4 py-3 font-medium">Status</th><th scope="col" className="px-4 py-3 font-medium">Requested</th><th scope="col" className="px-4 py-3 font-medium">Transcript</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(analyses ?? []).map((a) => {
                const ref = (Array.isArray(a.reference) ? a.reference[0] : a.reference) as { id: string; title: string } | null;
                return (
                  <tr key={a.id} className="hover:bg-surface-2">
                    <td className="px-4 py-3"><Link href={`/analyze/${a.id}`} className="font-medium text-fg hover:text-accent">{ref?.title ?? "Deleted reference"}</Link>{a.error && <p className="line-clamp-1 text-xs text-danger">{a.error}</p>}</td>
                    <td className="px-4 py-3"><Badge tone={TONE[a.status as keyof typeof TONE]} className="capitalize">{a.status}</Badge></td>
                    <td className="whitespace-nowrap px-4 py-3 text-fg-muted">{formatDateTime(a.created_at)}</td>
                    <td className="px-4 py-3 capitalize text-fg-muted">{a.transcript_status.replace("_", " ")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
