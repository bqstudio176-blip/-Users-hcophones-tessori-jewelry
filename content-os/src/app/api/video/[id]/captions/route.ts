import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { toSrt } from "@/server/video/captions";
import { Timeline } from "@/server/video/timeline";

/** SRT export of the CURRENT (saved) timeline's captions. RLS limits access to workspace members. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: p } = await supabase.from("video_projects").select("id, timeline").eq("id", id).maybeSingle();
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });
  const t = Timeline.safeParse(p.timeline);
  if (!t.success) return NextResponse.json({ error: "invalid timeline" }, { status: 422 });
  return new NextResponse(toSrt(t.data.captions.lines), {
    headers: { "content-type": "application/x-subrip; charset=utf-8", "content-disposition": `attachment; filename="captions-${id.slice(0, 8)}.srt"`, "cache-control": "no-store" },
  });
}
