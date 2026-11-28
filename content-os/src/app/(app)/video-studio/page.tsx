import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/creative/action-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, PageHeader, Stat } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatBytes } from "@/lib/discover/upload";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { createVideoFromScript } from "@/server/actions/video";
import { RENDER_STATUS_TONE, storageUsage, VIDEO_STATUS_LABEL } from "@/server/video/queries";
import { VIDEO_FORMATS } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Video Studio" };

export default async function VideoStudioPage({ searchParams }: { searchParams: Promise<{ script?: string; deleted?: string }> }) {
  const ctx = await getWorkspaceContext();
  const sp = await searchParams;
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [{ data: projects }, { data: scripts }, { data: renders }, usage] = await Promise.all([
    supabase.from("video_projects").select("id, title, status, format, timeline_version, updated_at, script_id, video_renders(id, kind, status, created_at)").eq("workspace_id", ctx.workspace.id).order("updated_at", { ascending: false }).limit(100),
    supabase.from("scripts").select("id, title, status, target_duration_seconds, updated_at").eq("workspace_id", ctx.workspace.id).neq("status", "archived").order("status").order("updated_at", { ascending: false }).limit(100),
    supabase.from("video_renders").select("kind, status, credits_charged, credits_refunded").eq("workspace_id", ctx.workspace.id).gte("created_at", since),
    storageUsage(ctx.workspace.id),
  ]);
  const list = projects ?? [];
  const credits = (renders ?? []).reduce((n, r) => n + (r.credits_refunded ? 0 : r.credits_charged), 0);
  const finals = (renders ?? []).filter((r) => r.kind === "final" && r.status === "completed").length;
  const pct = Math.min(100, Math.round((usage.used / usage.limit) * 100));

  return (
    <>
      <PageHeader title="Video Studio" description="Turn scripts into ready-to-post videos from footage you own: scenes, voiceover, captions and music, rendered on our servers." />
      {sp.deleted && <Alert tone="success" className="mb-4">Video deleted.</Alert>}
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        <Stat label="Videos" value={list.length} hint={`${list.filter((p) => p.status === "ready").length} ready to publish`} />
        <Stat label="Final renders (30 days)" value={finals} />
        <Stat label="Render credits (30 days)" value={credits} hint="Final: 3 up to 60 s, +1 per extra 30 s · drafts free" />
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-xs text-fg-subtle">Media storage</p>
          <p className="text-lg font-semibold tabular-nums text-fg">{formatBytes(usage.used)} <span className="text-xs font-normal text-fg-subtle">of {formatBytes(usage.limit)}</span></p>
          <div className="mt-2 h-1.5 rounded-full bg-surface-3"><div className={`h-1.5 rounded-full ${pct > 90 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} /></div>
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <section aria-label="Videos">
          {list.length === 0 ? (
            <EmptyState title="No videos yet" description="Create a video from a Script Lab script. Its scenes become your timeline." />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2">
              {list.map((p) => {
                const rs = ((p.video_renders ?? []) as { id: string; kind: string; status: string; created_at: string }[]).sort((a, b) => b.created_at.localeCompare(a.created_at));
                const last = rs[0];
                return (
                  <li key={p.id}>
                    <Link href={`/video-studio/${p.id}`} className="block h-full rounded-xl border border-line bg-surface p-4 transition-colors hover:border-accent/50">
                      <div className="mb-2 flex flex-wrap items-center gap-1.5">
                        <Badge tone={p.status === "ready" ? "success" : p.status === "archived" ? "neutral" : "info"}>{VIDEO_STATUS_LABEL[p.status] ?? p.status}</Badge>
                        <Badge>{VIDEO_FORMATS[p.format as keyof typeof VIDEO_FORMATS]?.label ?? p.format}</Badge>
                        {last && <Badge tone={RENDER_STATUS_TONE[last.status]}>{last.kind} render {last.status}</Badge>}
                      </div>
                      <p className="font-medium text-fg">{p.title}</p>
                      <p className="mt-1 text-xs text-fg-subtle">Timeline v{p.timeline_version} · updated {formatDateTime(p.updated_at)}{!p.script_id ? " · source script deleted" : ""}</p>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <Card>
          <CardHeader><CardTitle>New video</CardTitle><CardDescription>Start from a script. Approved scripts are listed first; the script version is saved with the video.</CardDescription></CardHeader>
          <CardContent>
            {(scripts ?? []).length === 0 ? (
              <p className="text-sm text-fg-muted">You need a script first. <Link href="/script-lab" className="text-accent">Open Script Lab</Link></p>
            ) : (
              <ActionForm action={createVideoFromScript} submitLabel="Create video" pendingLabel="Creating…">
                <Field label="Script" name="scriptId">
                  <Select name="scriptId" defaultValue={sp.script ?? ""} required>
                    <option value="" disabled>Choose a script</option>
                    {(scripts ?? []).map((s) => <option key={s.id} value={s.id}>{s.status === "approved" ? "✓ " : ""}{s.title} · {s.target_duration_seconds}s</option>)}
                  </Select>
                </Field>
                <Field label="Format" name="format">
                  <Select name="format" defaultValue="vertical">{Object.entries(VIDEO_FORMATS).map(([id, f]) => <option key={id} value={id}>{f.label} ({f.width}×{f.height})</option>)}</Select>
                </Field>
                <Field label="Title (optional)" name="title"><Input name="title" maxLength={200} placeholder="Defaults to the script title" /></Field>
              </ActionForm>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
