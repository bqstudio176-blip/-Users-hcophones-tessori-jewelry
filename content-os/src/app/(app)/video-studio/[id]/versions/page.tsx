import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { restoreTimelineVersion } from "@/server/actions/video";
import { timelineDuration } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Timeline versions" };

const SOURCE: Record<string, string> = { created: "Created from script", manual: "Saved manually", render: "Rendered", before_restore: "Before restore / update", restored: "Restored", script_update: "Updated from script" };

export default async function VersionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, timeline_version").eq("id", id).maybeSingle();
  if (!p) notFound();
  const { data: versions } = await supabase.from("video_timeline_versions").select("id, version, source, note, timeline, created_at").eq("project_id", id).order("created_at", { ascending: false }).limit(100);
  return (
    <>
      {sp.error && <Alert tone="danger" className="mb-4">{sp.error}</Alert>}
      <p className="mb-3 text-sm text-fg-muted">Snapshots are taken when the video is created, when you save a version, before and after restores, and every time you render. Restoring saves the current timeline first.</p>
      {(versions ?? []).length === 0 ? <EmptyState title="No versions" /> : (
        <ul className="space-y-2">
          {(versions ?? []).map((v) => {
            const tl = v.timeline as { scenes?: { duration: number; visual: unknown }[] };
            const scenes = tl.scenes ?? [];
            return (
              <li key={v.id}>
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-3 pt-4 text-sm">
                    <Badge>v{v.version}</Badge>
                    <span className="text-fg">{SOURCE[v.source] ?? v.source}</span>
                    {v.note && <span className="text-fg-muted">— {v.note}</span>}
                    <span className="text-xs text-fg-subtle">{scenes.length} scenes · {timelineDuration({ scenes: scenes as never }).toFixed(1)}s · {scenes.filter((s) => s.visual).length} with media</span>
                    <span className="ml-auto text-xs text-fg-subtle">{formatDateTime(v.created_at)}</span>
                    <form action={restoreTimelineVersion}><input type="hidden" name="id" value={id} /><input type="hidden" name="versionId" value={v.id} /><Button type="submit" size="sm" variant="outline">Restore</Button></form>
                  </CardContent>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
