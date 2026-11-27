import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { StrategyForm, type StrategyValues } from "@/components/creative/strategy-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";

export const metadata: Metadata = { title: "Strategy builder" };

export default async function StrategyBuilderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ strategy?: string; refs?: string }> }) {
  const ctx = await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: project } = await supabase.from("creative_projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) notFound();
  let values: StrategyValues = { name: `${project.name} strategy` };
  if (sp.strategy && uuidSchema.safeParse(sp.strategy).success) {
    const { data } = await supabase.from("content_strategies").select("*").eq("id", sp.strategy).maybeSingle();
    if (data) values = data as StrategyValues;
  } else if (sp.refs) {
    values.reference_ids = sp.refs.split(",").filter((r) => uuidSchema.safeParse(r).success);
  }
  const [{ data: refs }, { data: settings }] = await Promise.all([
    supabase.from("content_references").select("id, title, analysis_status").eq("workspace_id", ctx.workspace.id).order("updated_at", { ascending: false }).limit(60),
    supabase.from("workspace_settings").select("content_niche, brand_voice").eq("workspace_id", ctx.workspace.id).maybeSingle(),
  ]);

  return (
    <>
      <PageHeader title={values.id ? "Edit strategy" : "Strategy builder"} description={<>Project: <Link href={`/script-lab/projects/${id}`} className="text-accent">{project.name}</Link></>} />
      <Card className="max-w-3xl">
        <CardHeader><CardTitle>Strategy brief</CardTitle><CardDescription>Everything here is treated as information you provided. The AI labels its own suggestions as hypotheses.</CardDescription></CardHeader>
        <CardContent>
          <StrategyForm projectId={id} values={values} references={(refs ?? []).map((r) => ({ id: r.id, title: r.title, analyzed: r.analysis_status === "analyzed" }))} defaults={{ niche: settings?.content_niche, tone: null }} />
        </CardContent>
      </Card>
    </>
  );
}
