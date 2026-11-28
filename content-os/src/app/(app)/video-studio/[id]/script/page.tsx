import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { applyScriptUpdate } from "@/server/actions/video";
import { mergeScriptUpdate, Timeline, type ScriptSnapshotScene } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Update from script" };

export default async function ScriptUpdatePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, timeline, timeline_version, script_id, script_version, script_snapshot").eq("id", id).maybeSingle();
  if (!p) notFound();
  if (!p.script_id) return <Alert tone="warning">The source script was deleted, so there is nothing to update from.</Alert>;
  const [{ data: script }, { data: scenes }] = await Promise.all([
    supabase.from("scripts").select("id, title, current_version").eq("id", p.script_id).maybeSingle(),
    supabase.from("script_scenes").select("id, position, scene_title, estimated_duration_seconds, spoken_text, on_screen_text").eq("script_id", p.script_id).order("position"),
  ]);
  const t = Timeline.safeParse(p.timeline);
  if (!t.success) return <Alert tone="danger">The timeline could not be read.</Alert>;
  const { diff } = mergeScriptUpdate(t.data, ((p.script_snapshot as { scenes?: ScriptSnapshotScene[] })?.scenes ?? []), (scenes ?? []) as ScriptSnapshotScene[]);
  const nothing = !diff.added.length && !diff.removed.length && !diff.changed.length;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Update from “{script?.title}”</CardTitle>
        <CardDescription>Video uses script v{p.script_version}; the script is now v{script?.current_version}. Media, voice, transitions and any on-screen text you edited are kept. A version is saved before and after.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {sp.error && <Alert tone="danger">{sp.error}</Alert>}
        {nothing ? <p className="text-fg-muted">No scene-level changes. Updating only records the new script version.</p> : (
          <div className="grid gap-3 sm:grid-cols-3">
            <div><p className="text-xs font-medium uppercase tracking-wide text-success">Added</p><ul className="list-disc pl-4 text-fg-muted">{diff.added.map((s, i) => <li key={i}>{s}</li>)}{!diff.added.length && <li className="list-none">—</li>}</ul></div>
            <div><p className="text-xs font-medium uppercase tracking-wide text-warning">Changed text</p><ul className="list-disc pl-4 text-fg-muted">{diff.changed.map((s, i) => <li key={i}>{s}</li>)}{!diff.changed.length && <li className="list-none">—</li>}</ul></div>
            <div><p className="text-xs font-medium uppercase tracking-wide text-danger">Removed (media in them is dropped)</p><ul className="list-disc pl-4 text-fg-muted">{diff.removed.map((s, i) => <li key={i}>{s}</li>)}{!diff.removed.length && <li className="list-none">—</li>}</ul></div>
          </div>
        )}
        <div className="flex gap-2">
          <form action={applyScriptUpdate}><input type="hidden" name="id" value={id} /><input type="hidden" name="version" value={p.timeline_version} /><Button type="submit">Apply update</Button></form>
          <Link href={`/video-studio/${id}`} className="rounded-md px-3 py-2 text-sm text-fg-muted hover:bg-surface-2">Cancel</Link>
        </div>
        <p className="text-xs text-fg-subtle">Captions are not changed; regenerate them in the editor afterwards if the spoken text changed.</p>
      </CardContent>
    </Card>
  );
}
