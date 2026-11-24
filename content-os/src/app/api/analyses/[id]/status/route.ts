import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";

export const dynamic = "force-dynamic";

/** Real job progress for the processing screen (RLS-scoped; no fabricated percentages). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) return NextResponse.json({ error: "not found" }, { status: 404 });
  const supabase = await createClient();
  const { data: analysis } = await supabase
    .from("video_analyses")
    .select("id, status, transcript_status, visual_status, error, analysis_jobs(id, status, current_step, steps, attempts, max_attempts, last_error, cancel_requested, run_after)")
    .eq("id", id)
    .maybeSingle();
  if (!analysis) return NextResponse.json({ error: "not found" }, { status: 404 });
  const job = Array.isArray(analysis.analysis_jobs) ? analysis.analysis_jobs[0] : analysis.analysis_jobs;
  const { data: logs } = job
    ? await supabase.from("analysis_job_logs").select("id, level, step, message, created_at").eq("job_id", job.id).order("id", { ascending: false }).limit(25)
    : { data: [] };
  return NextResponse.json(
    { status: analysis.status, error: analysis.error, job: job ?? null, logs: (logs ?? []).reverse() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
