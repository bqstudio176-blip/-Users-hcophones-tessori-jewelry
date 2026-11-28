import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VideoEditor } from "@/components/video/video-editor";
import type { EditorAsset, EditorTake } from "@/components/video/types";
import { Alert } from "@/components/ui/alert";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { signMediaUrls } from "@/server/media-urls";
import { Timeline, type Word } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Video editor" };

export default async function VideoEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; restored?: string; voiceover?: string; script_updated?: string }> }) {
  const ctx = await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, status, timeline, timeline_version").eq("id", id).maybeSingle();
  if (!p) notFound();
  const parsed = Timeline.safeParse(p.timeline);
  if (!parsed.success) return <Alert tone="danger">This video's timeline could not be read. Restore a previous version from the Versions tab.</Alert>;
  const [{ data: assets }, { data: takes }] = await Promise.all([
    supabase.from("media_assets").select("id, kind, title, status, duration_seconds, has_audio, thumbnail_path, proxy_path").eq("workspace_id", ctx.workspace.id).in("status", ["ready", "processing"]).order("created_at", { ascending: false }).limit(300),
    supabase.from("voiceover_takes").select("id, scene_key, status, asset_id, transcript, deviation, created_at").eq("project_id", id).order("created_at", { ascending: false }),
  ]);
  const urls = await signMediaUrls((assets ?? []).flatMap((a) => [a.thumbnail_path, a.proxy_path]), 4 * 3600);
  const editorAssets: EditorAsset[] = (assets ?? []).map((a) => ({
    id: a.id, kind: a.kind, title: a.title, status: a.status, duration: a.duration_seconds === null ? null : Number(a.duration_seconds), hasAudio: a.has_audio,
    thumbUrl: a.thumbnail_path ? (urls[a.thumbnail_path] ?? null) : null, proxyUrl: a.proxy_path ? (urls[a.proxy_path] ?? null) : null,
  }));
  const editorTakes: EditorTake[] = (takes ?? []).map((t) => ({
    id: t.id, sceneKey: t.scene_key, status: t.status, assetId: t.asset_id, createdAt: t.created_at,
    words: ((t.transcript as { words?: Word[] } | null)?.words ?? []).slice(0, 5000),
    similarity: (t.deviation as { similarity?: number } | null)?.similarity ?? null,
  }));
  return (
    <>
      {sp.created && <Alert tone="success" className="mb-4">Video created from the script. Add media to each scene, then record a voiceover and render.</Alert>}
      {sp.restored && <Alert tone="success" className="mb-4">Version restored. The previous timeline was saved first.</Alert>}
      {sp.voiceover && <Alert tone="success" className="mb-4">Voiceover applied. Use “Fit scene durations to the voice” and regenerate captions if needed.</Alert>}
      {sp.script_updated && <Alert tone="success" className="mb-4">Updated from the latest script. Media and your text edits were kept.</Alert>}
      <VideoEditor key={p.timeline_version} projectId={id} initial={parsed.data} initialVersion={p.timeline_version} assets={editorAssets} takes={editorTakes} archived={p.status === "archived"} />
    </>
  );
}
