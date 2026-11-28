import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { AutoRefresh } from "@/components/video/auto-refresh";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatBytes } from "@/lib/discover/upload";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { deleteAsset, updateAsset } from "@/server/actions/video";
import { signMediaUrls } from "@/server/media-urls";

export const metadata: Metadata = { title: "Media file" };

export default async function MediaDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: a } = await supabase.from("media_assets").select("*").eq("id", id).maybeSingle();
  if (!a) notFound();
  const [{ data: links }, { data: takes }] = await Promise.all([
    supabase.from("video_project_assets").select("project_id, video_projects(id, title)").eq("asset_id", id),
    supabase.from("voiceover_takes").select("id, project_id").eq("asset_id", id),
  ]);
  const urls = await signMediaUrls([a.proxy_path, a.thumbnail_path]);
  const src = a.proxy_path ? urls[a.proxy_path] : undefined;
  const meta = a.metadata as { formatName?: string; video?: { codec: string; fps: number | null } | null; audio?: { codec: string; sampleRate: number | null; channels: number | null } | null };
  const used = (links ?? []).length + (takes ?? []).length;

  return (
    <>
      <AutoRefresh active={a.status === "processing"} />
      <PageHeader title={a.title} description={<><Link href="/video-studio/media" className="text-accent">Media library</Link> · {a.kind} · uploaded {formatDateTime(a.created_at)}</>} actions={<Badge tone={a.status === "ready" ? "success" : a.status === "failed" ? "danger" : "info"}>{a.status}</Badge>} />
      {sp.error && <Alert tone="danger" className="mb-4">{sp.error}</Alert>}
      {a.status === "failed" && <Alert tone="danger" className="mb-4">Processing failed: {a.error}</Alert>}
      {a.status === "processing" && <Alert tone="info" className="mb-4">Processing on the worker: reading the file and creating a preview.</Alert>}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Card>
          <CardContent className="pt-4">
            {src && a.kind === "video" && <video src={src} controls playsInline className="max-h-[60vh] w-full rounded-lg bg-black" />}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {src && a.kind === "image" && <img src={src} alt={a.title} className="max-h-[60vh] w-full rounded-lg bg-black object-contain" />}
            {src && a.kind === "audio" && <audio src={src} controls className="w-full" />}
            {!src && <p className="text-sm text-fg-muted">Preview available once processing finishes.</p>}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div><dt className="text-xs text-fg-subtle">Size</dt><dd className="text-fg">{formatBytes(Number(a.size_bytes))}</dd></div>
              {a.duration_seconds && <div><dt className="text-xs text-fg-subtle">Duration</dt><dd className="text-fg">{Number(a.duration_seconds).toFixed(2)}s</dd></div>}
              {a.width && <div><dt className="text-xs text-fg-subtle">Resolution</dt><dd className="text-fg">{a.width}×{a.height}</dd></div>}
              {meta?.video && <div><dt className="text-xs text-fg-subtle">Video</dt><dd className="text-fg">{meta.video.codec}{meta.video.fps ? ` · ${meta.video.fps} fps` : ""}</dd></div>}
              {meta?.audio && <div><dt className="text-xs text-fg-subtle">Audio</dt><dd className="text-fg">{meta.audio.codec}{meta.audio.sampleRate ? ` · ${meta.audio.sampleRate / 1000} kHz` : ""}</dd></div>}
              <div><dt className="text-xs text-fg-subtle">Rights</dt><dd className="text-fg">Confirmed {formatDateTime(a.rights_confirmed_at)}</dd></div>
            </dl>
          </CardContent>
        </Card>
        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <ActionForm action={updateAsset} submitLabel="Save" size="sm" variant="outline">
                <input type="hidden" name="id" value={a.id} />
                <Field label="Name" name="title"><Input name="title" defaultValue={a.title} maxLength={200} /></Field>
                <Field label="Tags (comma separated)" name="tags"><Input name="tags" defaultValue={(a.tags as string[]).join(", ")} maxLength={300} /></Field>
              </ActionForm>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Used in</CardTitle></CardHeader>
            <CardContent className="space-y-2 text-sm">
              {(links ?? []).map((l) => {
                const p = (Array.isArray(l.video_projects) ? l.video_projects[0] : l.video_projects) as { id: string; title: string } | null;
                return p ? <Link key={p.id} href={`/video-studio/${p.id}`} className="block text-accent">{p.title}</Link> : null;
              })}
              {(takes ?? []).length > 0 && <p className="text-fg-muted">{takes!.length} voiceover take(s)</p>}
              {used === 0 && <p className="text-fg-muted">Not used by any video.</p>}
              <form action={deleteAsset}>
                <input type="hidden" name="id" value={a.id} />
                <Button type="submit" size="sm" variant="ghost" className="text-danger" disabled={used > 0}>Delete file</Button>
              </form>
              {used > 0 && <p className="text-xs text-fg-subtle">Remove it from the videos above before deleting.</p>}
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
