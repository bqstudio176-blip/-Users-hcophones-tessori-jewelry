import { NextResponse, type NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { exportFileName, reportToMarkdown, type ExportInput } from "@/server/analysis/report-export";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  const format = req.nextUrl.searchParams.get("format") === "json" ? "json" : "md";

  const supabase = await createClient(); // RLS: only members of the analysis' workspace get rows
  const { data: analysis } = await supabase
    .from("video_analyses")
    .select("id, created_at, completed_at, media_metadata, reference:content_references(title, url, source_type, author_name)")
    .eq("id", id)
    .maybeSingle();
  const { data: report } = await supabase.from("analysis_reports").select("sections, model_provider, model_id, prompt_versions, user_notes, input_tokens, output_tokens").eq("analysis_id", id).maybeSingle();
  if (!analysis || !report) return NextResponse.json({ error: "not found" }, { status: 404 });
  const [{ data: scenes }, { data: transcript }] = await Promise.all([
    supabase.from("detected_scenes").select("idx, start_ms, end_ms, purpose, editing_notes, visual, transcript_excerpt").eq("analysis_id", id).order("idx"),
    supabase.from("transcripts").select("id, transcript_segments(start_ms, end_ms, text, idx)").eq("analysis_id", id).maybeSingle(),
  ]);
  const ref = (Array.isArray(analysis.reference) ? analysis.reference[0] : analysis.reference) as { title: string; url: string | null; source_type: string; author_name: string | null };
  const segments = ((transcript?.transcript_segments ?? []) as { start_ms: number; end_ms: number; text: string; idx: number }[]).sort((a, b) => a.idx - b.idx);
  const input: ExportInput = {
    title: ref.title,
    reference: ref,
    analysis: analysis as unknown as ExportInput["analysis"],
    report: report as unknown as ExportInput["report"],
    scenes: (scenes ?? []) as ExportInput["scenes"],
    segments,
  };
  const body = format === "json" ? JSON.stringify({ reference: ref, analysis, report, scenes, transcript: segments }, null, 2) : reportToMarkdown(input);
  return new NextResponse(body, {
    headers: {
      "Content-Type": format === "json" ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${exportFileName(ref.title, format)}"`,
      "Cache-Control": "no-store",
    },
  });
}
