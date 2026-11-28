import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/video/auto-refresh";
import { MediaUploadForm } from "@/components/video/media-upload-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatBytes } from "@/lib/discover/upload";
import { createClient } from "@/lib/supabase/server";
import { signMediaUrls } from "@/server/media-urls";
import { storageUsage } from "@/server/video/queries";

export const metadata: Metadata = { title: "Media library" };

const sel = "h-9 rounded-md border border-line bg-surface-2 px-2 text-sm text-fg";

export default async function MediaLibraryPage({ searchParams }: { searchParams: Promise<{ kind?: string; q?: string; deleted?: string }> }) {
  const ctx = await getWorkspaceContext();
  const sp = await searchParams;
  const supabase = await createClient();
  let query = supabase.from("media_assets").select("id, kind, title, status, error, size_bytes, duration_seconds, width, height, thumbnail_path, tags, origin, created_at").eq("workspace_id", ctx.workspace.id).neq("status", "pending_upload").order("created_at", { ascending: false }).limit(300);
  if (sp.kind && ["video", "image", "audio"].includes(sp.kind)) query = query.eq("kind", sp.kind);
  const q = (sp.q ?? "").trim().slice(0, 80).replace(/[%,()*\\]/g, " ");
  if (q) query = query.ilike("title", `%${q}%`);
  const [{ data: assets }, usage] = await Promise.all([query, storageUsage(ctx.workspace.id)]);
  const list = assets ?? [];
  const urls = await signMediaUrls(list.map((a) => a.thumbnail_path));
  const processing = list.some((a) => a.status === "processing");

  return (
    <>
      <AutoRefresh active={processing} />
      <PageHeader title="Media library" description={`Your own clips, images, recordings and music. ${formatBytes(usage.used)} of ${formatBytes(usage.limit)} used.`} />
      {sp.deleted && <Alert tone="success" className="mb-4">File deleted.</Alert>}
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <section>
          <form className="mb-4 flex flex-wrap gap-2" role="search">
            <label htmlFor="q" className="sr-only">Search media</label>
            <input id="q" name="q" defaultValue={sp.q ?? ""} placeholder="Search by name…" className={`${sel} min-w-48 flex-1`} />
            <select name="kind" defaultValue={sp.kind ?? ""} className={sel} aria-label="Type"><option value="">All types</option><option value="video">Video</option><option value="image">Images</option><option value="audio">Audio</option></select>
            <button type="submit" className="h-9 rounded-md bg-accent px-3 text-sm font-medium text-accent-fg">Filter</button>
          </form>
          {list.length === 0 ? <EmptyState title="No media yet" description="Upload clips, images, voice recordings or music you own." /> : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map((a) => (
                <li key={a.id}>
                  <Link href={`/video-studio/media/${a.id}`} className="block overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-accent/50">
                    <div className="grid aspect-video place-items-center bg-black text-xs text-white/60">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {a.thumbnail_path && urls[a.thumbnail_path] ? <img src={urls[a.thumbnail_path]} alt="" className="h-full w-full object-cover" /> : a.kind === "audio" ? "♪ audio" : a.status}
                    </div>
                    <div className="p-2">
                      <p className="truncate text-sm text-fg">{a.title}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1">
                        <Badge>{a.kind}</Badge>
                        {a.status !== "ready" && <Badge tone={a.status === "failed" ? "danger" : "info"}>{a.status}</Badge>}
                        {a.origin === "recording" && <Badge tone="info">recording</Badge>}
                        <span className="text-[11px] text-fg-subtle">{a.duration_seconds ? `${Number(a.duration_seconds).toFixed(1)}s · ` : ""}{formatBytes(Number(a.size_bytes))}</span>
                      </div>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <Card>
          <CardHeader><CardTitle>Upload</CardTitle></CardHeader>
          <CardContent><MediaUploadForm /></CardContent>
        </Card>
      </div>
    </>
  );
}
