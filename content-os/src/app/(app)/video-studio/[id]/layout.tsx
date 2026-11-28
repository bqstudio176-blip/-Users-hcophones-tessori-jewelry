import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { VideoProjectNav } from "@/components/video/video-studio-nav";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { VIDEO_STATUS_LABEL } from "@/server/video/queries";
import { VIDEO_FORMATS } from "@/server/video/timeline";

export default async function VideoProjectLayout({ params, children }: { params: Promise<{ id: string }>; children: ReactNode }) {
  await getWorkspaceContext();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, title, status, format, script_id, script_version, scripts(id, title, current_version)").eq("id", id).maybeSingle();
  if (!p) notFound();
  const script = (Array.isArray(p.scripts) ? p.scripts[0] : p.scripts) as { id: string; title: string; current_version: number } | null;
  const changed = script && p.script_version !== null && script.current_version > p.script_version;
  return (
    <>
      <PageHeader
        title={p.title}
        description={<>{VIDEO_FORMATS[p.format as keyof typeof VIDEO_FORMATS]?.label} · {script ? <>from <Link href={`/script-lab/scripts/${script.id}`} className="text-accent">{script.title}</Link> (v{p.script_version})</> : "source script deleted"}</>}
        actions={<Badge tone={p.status === "ready" ? "success" : p.status === "archived" ? "neutral" : "info"}>{VIDEO_STATUS_LABEL[p.status] ?? p.status}</Badge>}
      />
      {changed && (
        <div className="mb-4 rounded-lg border border-warning/40 bg-surface-2 p-3 text-sm text-fg">
          The script changed after this video was created (v{p.script_version} → v{script!.current_version}). <Link href={`/video-studio/${id}/script`} className="text-accent">Review and update from script</Link>
        </div>
      )}
      <VideoProjectNav id={id} />
      {children}
    </>
  );
}
