import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { RequestAnalysisForm } from "@/components/analyze/request-analysis-form";
import { ANALYSIS_TONE, Thumbnail } from "@/components/discover/reference-card";
import { UploadForm } from "@/components/discover/import-forms";
import { ReferenceEditForm } from "@/components/discover/reference-edit-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { ANALYSIS_STATUS_LABELS, SOURCE_LABELS } from "@/lib/discover/catalog";
import { formatBytes } from "@/lib/discover/upload";
import { formatCompact, formatDateTime, formatDuration } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { deleteReference } from "@/server/actions/discover";
import { signMediaUrls } from "@/server/media-urls";

export const metadata: Metadata = { title: "Reference" };

const CHECK_TONE = { reachable: "success", login_required: "warning", not_found: "danger", private: "warning", unverifiable: "neutral", not_checked: "neutral" } as const;

export default async function ReferencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ imported?: string; uploaded?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: r } = await supabase.from("content_references").select("*, reference_tags(tag)").eq("id", id).maybeSingle();
  if (!r) notFound();
  const [{ data: analyses }, { data: cost }] = await Promise.all([
    supabase.from("video_analyses").select("id, status, created_at, completed_at, error").eq("reference_id", id).order("created_at", { ascending: false }),
    supabase.rpc("analysis_credit_cost"),
  ]);
  const urls = await signMediaUrls([r.media_status === "uploaded" ? r.media_path : null, r.thumbnail_path]);
  const videoUrl = r.media_path ? urls[r.media_path] ?? null : null;
  const thumb = r.thumbnail_path ? urls[r.thumbnail_path] ?? null : r.thumbnail_url;
  const check = r.url_check as { status?: keyof typeof CHECK_TONE; note?: string; checkedAt?: string; httpStatus?: number };
  const tags = ((r.reference_tags ?? []) as { tag: string }[]).map((t) => t.tag);
  const metrics = r.metrics as Record<string, number>;
  const active = (analyses ?? []).find((a) => a.status === "queued" || a.status === "processing");
  const latestDone = (analyses ?? []).find((a) => a.status === "completed");

  return (
    <>
      <PageHeader
        title={r.title}
        description={<>{SOURCE_LABELS[r.source_type] ?? r.source_type}{r.author_name ? ` · ${r.author_name}` : ""} · added {formatDateTime(r.created_at)}</>}
        actions={<Badge tone={ANALYSIS_TONE[r.analysis_status]}>{ANALYSIS_STATUS_LABELS[r.analysis_status]}</Badge>}
      />
      {sp.imported && <Alert tone="success" className="mb-4">Reference saved to your library.</Alert>}
      {sp.uploaded && <Alert tone="success" className="mb-4">Video uploaded. You can analyze it now.</Alert>}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          <Card className="overflow-hidden">
            <div className="bg-black">
              {videoUrl ? (
                <video src={videoUrl} poster={thumb ?? undefined} controls playsInline preload="metadata" className="mx-auto max-h-[32rem] w-full" />
              ) : (
                <div className="mx-auto aspect-video max-h-[24rem]"><Thumbnail src={thumb} alt="" /></div>
              )}
            </div>
            <CardContent>
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div><dt className="text-xs text-fg-subtle">Duration</dt><dd className="text-fg">{formatDuration(r.duration_seconds)}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Category</dt><dd className="text-fg">{r.category ?? "—"}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Video file</dt><dd className="text-fg">{r.media_status === "uploaded" ? `${r.media_mime?.split("/")[1]?.toUpperCase()} · ${formatBytes(Number(r.media_size_bytes))}` : r.media_status === "pending_upload" ? "Upload not finished" : "None"}</dd></div>
                {r.url && <div className="sm:col-span-3"><dt className="text-xs text-fg-subtle">URL</dt><dd className="break-all"><a href={r.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-hover">{r.url}</a></dd></div>}
                {Object.keys(metrics).length > 0 && <div className="sm:col-span-3"><dt className="text-xs text-fg-subtle">Provider-reported metrics{r.retrieved_at ? ` (retrieved ${formatDateTime(r.retrieved_at)})` : ""}</dt><dd className="text-fg">{Object.entries(metrics).map(([k, v]) => `${formatCompact(v)} ${k}`).join(" · ")}</dd></div>}
              </dl>
              {check.status && (
                <div className="mt-4 flex flex-wrap items-start gap-2 rounded-md border border-line bg-surface-2 p-3 text-xs">
                  <Badge tone={CHECK_TONE[check.status]}>{check.status.replace(/_/g, " ")}</Badge>
                  <span className="text-fg-muted">{check.note}{check.checkedAt ? ` · checked ${formatDateTime(check.checkedAt)}` : ""}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Details</CardTitle><CardDescription>Title, category, tags and your notes.</CardDescription></CardHeader>
            <CardContent><ReferenceEditForm r={{ id: r.id, title: r.title, description: r.description, category: r.category, notes: r.notes, tags }} /></CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Analysis</CardTitle><CardDescription>Transcript, scenes, hook, storytelling, retention structure, CTA and editing.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {r.media_status !== "uploaded" ? (
                <>
                  <p className="text-sm text-fg-muted">Upload the video file to analyze this reference{r.source_type !== "upload" ? ". Content OS cannot download it from the source" : ""}.</p>
                  <UploadForm referenceId={r.id} compact />
                </>
              ) : active ? (
                <Link href={`/analyze/${active.id}`} className="text-sm text-accent hover:text-accent-hover">Analysis in progress — view progress →</Link>
              ) : (
                <RequestAnalysisForm referenceId={r.id} cost={Number(cost ?? 5)} label={latestDone ? "Re-run analysis" : "Analyze video"} />
              )}
              {latestDone && <Link href={`/analyze/${latestDone.id}`} className="block text-sm text-accent hover:text-accent-hover">Open latest report →</Link>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Analysis history</CardTitle></CardHeader>
            <CardContent>
              {(analyses ?? []).length === 0 ? <EmptyState title="No analyses yet" className="py-6" /> : (
                <ul className="space-y-2">
                  {(analyses ?? []).map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 text-sm">
                      <Link href={`/analyze/${a.id}`} className="text-fg hover:text-accent">{formatDateTime(a.created_at)}</Link>
                      <Badge tone={a.status === "completed" ? "success" : a.status === "failed" ? "danger" : a.status === "canceled" ? "neutral" : "info"} className="capitalize">{a.status}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Danger zone</CardTitle></CardHeader>
            <CardContent>
              <form action={deleteReference}>
                <input type="hidden" name="referenceId" value={r.id} />
                <Button type="submit" variant="outline" className="text-danger" disabled={Boolean(active)}>Delete reference</Button>
              </form>
              <p className="mt-2 text-xs text-fg-subtle">Deletes the reference, its video file, analyses, transcripts and frames. {active ? "Unavailable while an analysis is running." : ""}</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
