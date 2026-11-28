import type { Metadata } from "next";
import { randomUUID } from "node:crypto";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { FeedbackWidget } from "@/components/creative/feedback-widget";
import { AutoRefresh } from "@/components/video/auto-refresh";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatBytes } from "@/lib/discover/upload";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { cancelRender, deleteVideo, markReady, requestRender, setArchived } from "@/server/actions/video";
import { signMediaUrls } from "@/server/media-urls";
import { renderCredits, type CheckReport } from "@/server/video/checks";
import { VIDEO_JOB_STEPS } from "@/server/video/steps";
import { RENDER_STATUS_TONE } from "@/server/video/queries";
import { timelineDuration, Timeline } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Render & checks" };

const CHECK_TONE = { pass: "success", warn: "warning", fail: "danger" } as const;

export default async function RendersPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ queued?: string; error?: string; ready?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, title, status, timeline, timeline_version, ready_render_id").eq("id", id).maybeSingle();
  if (!p) notFound();
  const { data: renders } = await supabase.from("video_renders").select("id, kind, status, timeline_version, duration_seconds, output_path, srt_path, stats, checks, error, credits_charged, credits_refunded, created_at, completed_at, video_jobs(current_step, steps, attempts, max_attempts, last_error)").eq("project_id", id).order("created_at", { ascending: false }).limit(30);
  const list = renders ?? [];
  const urls = await signMediaUrls(list.flatMap((r) => [r.output_path, r.srt_path]));
  const t = Timeline.safeParse(p.timeline);
  const seconds = t.success ? timelineDuration(t.data) : 0;
  const active = list.find((r) => r.status === "queued" || r.status === "processing");
  const key = randomUUID();
  const latestFinal = list.find((r) => r.kind === "final" && r.status === "completed");

  return (
    <>
      <AutoRefresh active={Boolean(active)} intervalMs={3000} />
      {sp.queued && <Alert tone="success" className="mb-4">{sp.queued === "final" ? "Final render queued." : "Draft render queued."} It runs on the render worker; this page updates automatically.</Alert>}
      {sp.ready && <Alert tone="success" className="mb-4">Marked ready to publish.</Alert>}
      {sp.error && <Alert tone="danger" className="mb-4">{sp.error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
        <section className="space-y-4">
          {list.length === 0 && <EmptyState title="No renders yet" description="Start with a free draft to check timing, then render the final video." />}
          {list.map((r) => {
            const job = (Array.isArray(r.video_jobs) ? r.video_jobs[0] : r.video_jobs) as { current_step: string | null; steps: { step: string; status: string; detail?: string }[]; attempts: number; max_attempts: number; last_error: string | null } | null;
            const checks = r.checks as CheckReport | null;
            const stats = r.stats as { durationSeconds: number; width: number; height: number; integratedLufs: number | null; sizeBytes: number | null } | null;
            const video = r.output_path ? urls[r.output_path] : undefined;
            const isCurrent = r.timeline_version === p.timeline_version;
            return (
              <Card key={r.id}>
                <CardHeader>
                  <div className="flex flex-wrap items-center gap-2">
                    <CardTitle className="capitalize">{r.kind} render</CardTitle>
                    <Badge tone={RENDER_STATUS_TONE[r.status]}>{r.status}</Badge>
                    {checks && <Badge tone={CHECK_TONE[checks.overall]}>checks: {checks.overall}</Badge>}
                    {p.ready_render_id === r.id && <Badge tone="success">Ready to publish</Badge>}
                    {!isCurrent && <Badge>timeline v{r.timeline_version} (current v{p.timeline_version})</Badge>}
                    <span className="ml-auto text-xs text-fg-subtle">{formatDateTime(r.created_at)} · {Number(r.duration_seconds).toFixed(1)}s · {r.credits_charged ? `${r.credits_charged} credits${r.credits_refunded ? " (refunded)" : ""}` : "free"}</span>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {(r.status === "queued" || r.status === "processing") && job && (
                    <div>
                      <ol className="flex flex-wrap gap-2 text-xs">
                        {VIDEO_JOB_STEPS.render.map((s) => {
                          const st = job.steps.find((x) => x.step === s.id)?.status ?? "pending";
                          return <li key={s.id} className={`rounded-full border px-2 py-0.5 ${st === "done" ? "border-success/50 text-success" : st === "running" ? "border-accent text-fg" : "border-line text-fg-subtle"}`}>{st === "running" ? "● " : st === "done" ? "✓ " : ""}{s.label}</li>;
                        })}
                      </ol>
                      <p className="mt-2 text-xs text-fg-subtle">{r.status === "queued" ? "Waiting for a render worker." : `Attempt ${job.attempts} of ${job.max_attempts}.`} No percentage is shown because the encoder does not report one reliably.</p>
                      <form action={cancelRender} className="mt-2"><input type="hidden" name="id" value={id} /><input type="hidden" name="renderId" value={r.id} /><Button type="submit" size="sm" variant="ghost" className="text-danger">Cancel render</Button></form>
                    </div>
                  )}
                  {r.status === "failed" && <Alert tone="danger">Render failed: {r.error}. {r.credits_refunded ? "Credits were refunded." : ""}</Alert>}
                  {video && <video src={video} controls playsInline className="mx-auto max-h-[70vh] rounded-lg bg-black" />}
                  {stats && <p className="text-xs text-fg-muted">Measured: {stats.width}×{stats.height} · {stats.durationSeconds.toFixed(2)}s{stats.integratedLufs !== null ? ` · ${stats.integratedLufs.toFixed(1)} LUFS` : ""}{stats.sizeBytes ? ` · ${formatBytes(stats.sizeBytes)}` : ""}</p>}
                  {checks && (
                    <ul className="grid gap-1 text-sm sm:grid-cols-2">
                      {checks.items.map((c) => (
                        <li key={c.id} className="flex items-start gap-2 rounded-md border border-line p-2">
                          <Badge tone={CHECK_TONE[c.status]}>{c.status}</Badge>
                          <span><span className="text-fg">{c.label}</span><span className="block text-xs text-fg-muted">{c.detail}</span></span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {r.status === "completed" && (
                    <div className="flex flex-wrap items-center gap-2">
                      {video && <a href={video} download className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-surface-2">Download MP4</a>}
                      {r.srt_path && urls[r.srt_path] && <a href={urls[r.srt_path]} download className="rounded-md border border-line px-3 py-1.5 text-sm text-fg hover:bg-surface-2">Download SRT</a>}
                      {r.kind === "final" && isCurrent && p.ready_render_id !== r.id && checks && checks.overall !== "fail" && (
                        <form action={markReady}><input type="hidden" name="id" value={id} /><input type="hidden" name="renderId" value={r.id} /><Button type="submit" size="sm">Mark ready to publish</Button></form>
                      )}
                      {r.kind === "final" && checks?.overall === "fail" && <span className="text-xs text-fg-subtle">Resolve the failing checks before marking ready.</span>}
                    </div>
                  )}
                  {r.status === "completed" && <FeedbackWidget targetType="video_render" targetId={r.id} targetVersion={r.timeline_version} />}
                </CardContent>
              </Card>
            );
          })}
        </section>

        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Render</CardTitle><CardDescription>Timeline v{p.timeline_version} · {seconds.toFixed(1)}s. Save your edits in the editor first — renders use the saved timeline.</CardDescription></CardHeader>
            <CardContent className="space-y-3">
              <ActionForm action={requestRender} submitLabel="Render draft (free)" pendingLabel="Queuing…" variant="outline" size="sm" className="space-y-1">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="kind" value="draft" /><input type="hidden" name="key" value={key} />
                <p className="text-xs text-fg-subtle">540×960, watermarked, fast. Up to 10 per hour.</p>
              </ActionForm>
              <ActionForm action={requestRender} submitLabel={`Render final (${renderCredits("final", seconds)} credits)`} pendingLabel="Queuing…" size="sm" className="space-y-1">
                <input type="hidden" name="id" value={id} /><input type="hidden" name="kind" value="final" /><input type="hidden" name="key" value={randomUUID()} />
                <p className="text-xs text-fg-subtle">Full resolution, H.264/AAC, loudness normalised to −14 LUFS. Refunded automatically if it fails or you cancel.</p>
              </ActionForm>
              {active && <p className="text-xs text-fg-muted">A render is in progress.</p>}
            </CardContent>
          </Card>
          {latestFinal && <Card><CardContent className="pt-4 text-xs text-fg-muted">Latest final render: {formatDateTime(latestFinal.created_at)}{latestFinal.timeline_version !== p.timeline_version ? " — the timeline changed since then." : "."}</CardContent></Card>}
          <Card>
            <CardHeader><CardTitle>Manage</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              <form action={setArchived}><input type="hidden" name="id" value={id} /><input type="hidden" name="archived" value={p.status === "archived" ? "false" : "true"} /><Button type="submit" size="sm" variant="outline">{p.status === "archived" ? "Unarchive" : "Archive"}</Button></form>
              <form action={deleteVideo}><input type="hidden" name="id" value={id} /><Button type="submit" size="sm" variant="ghost" className="text-danger">Delete video</Button></form>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
