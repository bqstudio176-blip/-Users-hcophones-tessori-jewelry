import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/video/auto-refresh";
import { VoiceoverRecorder } from "@/components/video/voiceover-recorder";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { deleteTake, applyTake } from "@/server/actions/video";
import { signMediaUrls } from "@/server/media-urls";
import { Timeline } from "@/server/video/timeline";

export const metadata: Metadata = { title: "Voiceover" };

const STATUS: Record<string, { label: string; tone: "info" | "success" | "warning" | "danger" | "neutral" }> = {
  pending: { label: "Waiting", tone: "info" }, transcribing: { label: "Transcribing", tone: "info" }, completed: { label: "Transcribed", tone: "success" },
  unavailable: { label: "Not transcribed", tone: "warning" }, failed: { label: "Failed", tone: "danger" },
};

export default async function VoiceoverPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  const supabase = await createClient();
  const { data: p } = await supabase.from("video_projects").select("id, timeline").eq("id", id).maybeSingle();
  if (!p) notFound();
  const t = Timeline.safeParse(p.timeline);
  const scenes = t.success ? t.data.scenes.map((s) => ({ id: s.id, title: s.title, spoken_text: s.spoken_text })) : [];
  const inUse = new Set(t.success ? [t.data.voiceover?.take_id, ...t.data.scenes.map((s) => s.voice?.take_id)].filter(Boolean) as string[] : []);
  const { data: takes } = await supabase.from("voiceover_takes").select("id, scene_key, status, error, transcript, deviation, created_at, media_assets(id, status, proxy_path, duration_seconds)").eq("project_id", id).order("created_at", { ascending: false });
  const assetOf = (x: { media_assets: unknown }) => (Array.isArray(x.media_assets) ? x.media_assets[0] : x.media_assets) as { id: string; status: string; proxy_path: string | null; duration_seconds: number | null } | null;
  const urls = await signMediaUrls((takes ?? []).map((x) => assetOf(x)?.proxy_path));
  const active = (takes ?? []).some((x) => ["pending", "transcribing"].includes(x.status) || assetOf(x)?.status === "processing");

  return (
    <>
      <AutoRefresh active={active} />
      {sp.error && <Alert tone="danger" className="mb-4">{sp.error}</Alert>}
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Card>
          <CardHeader><CardTitle>Record</CardTitle><CardDescription>Read from the teleprompter. Each take is saved privately and transcribed to time captions and check it against the script.</CardDescription></CardHeader>
          <CardContent><VoiceoverRecorder projectId={id} scenes={scenes} /></CardContent>
        </Card>
        <section aria-label="Takes" className="space-y-3">
          <h2 className="text-sm font-semibold text-fg">Takes</h2>
          {(takes ?? []).length === 0 ? <EmptyState title="No takes yet" description="Record or upload a voiceover." /> : (takes ?? []).map((x) => {
            const a = assetOf(x);
            const dev = x.deviation as { similarity: number; missing: string[]; extra: string[] } | null;
            const scene = x.scene_key ? scenes.findIndex((s) => s.id === x.scene_key) : -1;
            const st = STATUS[x.status] ?? STATUS.pending!;
            return (
              <Card key={x.id}>
                <CardContent className="space-y-2 pt-4 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={st.tone}>{a?.status === "processing" ? "Processing audio" : st.label}</Badge>
                    <Badge>{x.scene_key ? (scene >= 0 ? `Scene ${scene + 1}` : "Removed scene") : "Whole script"}</Badge>
                    {inUse.has(x.id) && <Badge tone="success">In timeline</Badge>}
                    <span className="ml-auto text-xs text-fg-subtle">{formatDateTime(x.created_at)}</span>
                  </div>
                  {a?.proxy_path && urls[a.proxy_path] && <audio src={urls[a.proxy_path]} controls className="w-full" />}
                  {dev && (
                    <p className="text-xs text-fg-muted">
                      {Math.round(dev.similarity * 100)}% match with the script.
                      {dev.missing.length > 0 && <> Skipped: <span className="text-fg">{dev.missing.slice(0, 12).join(", ")}</span>.</>}
                      {dev.extra.length > 0 && <> Added: <span className="text-fg">{dev.extra.slice(0, 12).join(", ")}</span>.</>}
                    </p>
                  )}
                  {x.error && <p className="text-xs text-fg-subtle">{x.error}</p>}
                  <div className="flex gap-2">
                    <form action={applyTake}><input type="hidden" name="id" value={id} /><input type="hidden" name="takeId" value={x.id} /><Button type="submit" size="sm" variant="outline" disabled={a?.status !== "ready" || inUse.has(x.id)}>Use in timeline</Button></form>
                    <form action={deleteTake}><input type="hidden" name="id" value={id} /><input type="hidden" name="takeId" value={x.id} /><Button type="submit" size="sm" variant="ghost" className="text-danger" disabled={inUse.has(x.id)}>Delete</Button></form>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      </div>
    </>
  );
}
