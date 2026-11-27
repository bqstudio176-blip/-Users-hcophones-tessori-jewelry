import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { ButtonLink } from "@/components/ui/button";
import { getWorkspaceContext } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { generateScriptAction } from "@/server/actions/creative";
import { SCRIPT_FORMATS } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Generate script" };

export default async function NewScriptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ strategy?: string; hook?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: project } = await supabase.from("creative_projects").select("id, name").eq("id", id).maybeSingle();
  if (!project) notFound();
  const [{ data: strategies }, { data: hooks }] = await Promise.all([
    supabase.from("content_strategies").select("id, name, preferred_format, duration_seconds, tone").eq("project_id", id).order("updated_at", { ascending: false }),
    supabase.from("generated_hooks").select("id, text, is_favorite").eq("project_id", id).order("is_favorite", { ascending: false }).order("created_at", { ascending: false }).limit(50),
  ]);
  const strategy = (strategies ?? []).find((s) => s.id === sp.strategy) ?? strategies?.[0];

  return (
    <>
      <PageHeader title="Generate a script" description={<>Project: <Link href={`/script-lab/projects/${id}`} className="text-accent">{project.name}</Link></>} />
      <Card className="max-w-2xl">
        <CardHeader><CardTitle>Script brief</CardTitle><CardDescription>The Script Agent uses the strategy, the selected hook, relevant rules and your analyzed references (for technique only). 4 credits; failed generations are free.</CardDescription></CardHeader>
        <CardContent>
          {!strategy ? <EmptyState title="Create a strategy first" action={<ButtonLink href={`/script-lab/projects/${id}/strategy`} size="sm">Strategy builder</ButtonLink>} /> : (
            <ActionForm action={generateScriptAction} submitLabel="Generate script" pendingLabel="Script Agent writing (this can take a minute)…">
              <Field label="Strategy" name="strategyId"><Select name="strategyId" defaultValue={strategy.id}>{(strategies ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
              <Field label="Hook" name="hookId" hint="Optional — without one, the agent writes its own opening.">
                <Select name="hookId" defaultValue={sp.hook ?? ""}><option value="">Let the agent write the hook</option>{(hooks ?? []).map((h) => <option key={h.id} value={h.id}>{h.is_favorite ? "★ " : ""}{h.text.slice(0, 90)}</option>)}</Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Format" name="format"><Select name="format" defaultValue={strategy.preferred_format}>{SCRIPT_FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</Select></Field>
                <Field label="Target duration (s)" name="durationSeconds"><Input name="durationSeconds" type="number" min={5} max={1800} defaultValue={strategy.duration_seconds} /></Field>
                <Field label="Tone" name="tone"><Input name="tone" maxLength={80} defaultValue={strategy.tone ?? ""} /></Field>
              </div>
              <Field label="Instructions (optional)" name="instructions"><Textarea name="instructions" maxLength={1500} placeholder="e.g. include one personal example; avoid jargon" /></Field>
            </ActionForm>
          )}
        </CardContent>
      </Card>
    </>
  );
}
