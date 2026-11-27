import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ActionForm } from "@/components/creative/action-form";
import { FeedbackWidget } from "@/components/creative/feedback-widget";
import { SceneEditForm } from "@/components/creative/scene-edit-form";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { applyProposal, deleteScript, discardProposal, generateAlternative, proposeEdit, runQualityCheck, saveScriptVersion, sceneCommand, updateScriptMeta } from "@/server/actions/creative";
import { labelOf, SCRIPT_FORMATS, SCRIPT_SECTIONS } from "@/server/creative/catalog";
import { checkScriptDuration, estimateSpeechSeconds } from "@/server/creative/duration";

export const metadata: Metadata = { title: "Script editor" };

type Scene = { id: string; position: number; section: string; scene_title: string; estimated_duration_seconds: number; spoken_text: string; visual_direction: string; camera_direction: string; on_screen_text: string; audio_direction: string; transition: string; creative_purpose: string; is_locked: boolean };
type Proposal = { op: string; summary: string; base_version: number; created_at: string; scenes: (Omit<Scene, "position" | "id" | "is_locked"> & { id: string | null })[] };

function SceneButton({ scriptId, sceneId, cmd, label, danger, disabled }: { scriptId: string; sceneId: string; cmd: string; label: string; danger?: boolean; disabled?: boolean }) {
  return (
    <form action={sceneCommand}>
      <input type="hidden" name="scriptId" value={scriptId} />
      <input type="hidden" name="sceneId" value={sceneId} />
      <input type="hidden" name="cmd" value={cmd} />
      <button type="submit" disabled={disabled} className={`rounded px-2 py-1 text-xs hover:bg-surface-2 disabled:opacity-40 ${danger ? "text-danger" : "text-fg-muted"}`}>{label}</button>
    </form>
  );
}

export default async function ScriptEditorPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ generated?: string; restored?: string; applied?: string; proposal_error?: string }> }) {
  await getWorkspaceContext();
  const { id } = await params;
  const sp = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: script } = await supabase.from("scripts").select("*").eq("id", id).maybeSingle();
  if (!script) notFound();
  const [{ data: scenesRaw }, { data: project }, { data: latestReport }] = await Promise.all([
    supabase.from("script_scenes").select("*").eq("script_id", id).order("position"),
    supabase.from("creative_projects").select("id, name").eq("id", script.project_id).maybeSingle(),
    supabase.from("script_quality_reports").select("id, script_version, created_at").eq("script_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
  ]);
  const scenes = ((scenesRaw ?? []) as Scene[]).map((s) => ({ ...s, estimated_duration_seconds: Number(s.estimated_duration_seconds) }));
  const duration = checkScriptDuration(scenes, script.target_duration_seconds);
  const proposal = script.pending_proposal as Proposal | null;
  const sections = (script.sections ?? {}) as Record<string, string | null | unknown>;
  const rulesApplied = (sections.rules_applied as { rule_id: string; how: string }[] | undefined) ?? [];
  const assumptions = (sections.assumptions as string[] | undefined) ?? [];
  const lockedCount = scenes.filter((s) => s.is_locked).length;

  return (
    <>
      <PageHeader
        title={script.title}
        description={<>{labelOf(SCRIPT_FORMATS, script.format)} · target {script.target_duration_seconds}s · version {script.current_version} · {project && <Link href={`/script-lab/projects/${project.id}`} className="text-accent">{project.name}</Link>}</>}
        actions={<div className="flex gap-2"><ButtonLink href={`/script-lab/scripts/${id}/versions`} variant="outline" size="sm">Versions</ButtonLink><ButtonLink href={`/script-lab/scripts/${id}/quality`} variant="outline" size="sm">Quality</ButtonLink></div>}
      />
      {sp.generated && <Alert tone="success" className="mb-4">Script generated (version 1). Review and edit the scenes below.</Alert>}
      {sp.restored && <Alert tone="success" className="mb-4">Version {sp.restored} restored. The previous content was saved as a version first.</Alert>}
      {sp.applied && <Alert tone="success" className="mb-4">AI proposal applied. The previous content was saved as a version first.</Alert>}
      {sp.proposal_error && <Alert tone="danger" className="mb-4">{sp.proposal_error}</Alert>}

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardContent className="grid gap-4 pt-4 sm:grid-cols-4">
              <div><p className="text-xs text-fg-subtle">Estimated total</p><p className="text-xl font-semibold tabular-nums text-fg">{duration.estimatedTotalSeconds}s</p></div>
              <div><p className="text-xs text-fg-subtle">Target</p><p className="text-xl font-semibold tabular-nums text-fg">{duration.targetSeconds}s <span className="text-xs font-normal text-fg-subtle">±{duration.toleranceSeconds}s</span></p></div>
              <div><p className="text-xs text-fg-subtle">Speech-only estimate</p><p className="text-xl font-semibold tabular-nums text-fg">{duration.speechOnlySeconds}s</p></div>
              <div><p className="text-xs text-fg-subtle">Status</p><Badge tone={duration.status === "within_target" ? "success" : "warning"}>{duration.status.replace("_", " ")}</Badge></div>
              <p className="text-xs text-fg-subtle sm:col-span-4">Estimates from scene lengths and ~2.5 spoken words per second. Actual duration is only known after recording.{duration.overloadedScenes.length ? ` Speech may be too dense in scene(s) ${duration.overloadedScenes.map((s) => s.index + 1).join(", ")}.` : ""}</p>
            </CardContent>
          </Card>

          {proposal && (
            <Card className="border-accent/40">
              <CardHeader>
                <CardTitle>AI proposal awaiting your confirmation</CardTitle>
                <CardDescription>{proposal.op.replace(/_/g, " ")} · {formatDateTime(proposal.created_at)} — {proposal.summary}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {proposal.base_version !== script.current_version && <Alert tone="warning">The script changed after this proposal was generated (v{proposal.base_version} → v{script.current_version}). Applying is blocked to protect your edits; discard and generate a new proposal.</Alert>}
                <ol className="space-y-2">
                  {proposal.scenes.map((p, i) => {
                    const cur = p.id ? scenes.find((s) => s.id === p.id) : undefined;
                    const changed = !cur || cur.spoken_text !== p.spoken_text || cur.visual_direction !== p.visual_direction || cur.scene_title !== p.scene_title;
                    return (
                      <li key={i} className={`grid gap-2 rounded-md border p-2 text-sm sm:grid-cols-2 ${changed ? "border-accent/40" : "border-line opacity-70"}`}>
                        <div><p className="text-xs text-fg-subtle">Current {cur ? `· ${cur.scene_title}` : "· (new scene)"}{cur?.is_locked ? " · 🔒 locked" : ""}</p><p className="text-fg-muted">{cur?.spoken_text ?? "—"}</p></div>
                        <div><p className="text-xs text-fg-subtle">Proposed · {p.scene_title} · {p.estimated_duration_seconds}s</p><p className="text-fg">{p.spoken_text}</p></div>
                      </li>
                    );
                  })}
                </ol>
                <div className="flex justify-end gap-2">
                  <form action={discardProposal}><input type="hidden" name="scriptId" value={id} /><Button type="submit" variant="ghost" size="sm">Discard</Button></form>
                  <form action={applyProposal}><input type="hidden" name="scriptId" value={id} /><Button type="submit" size="sm" disabled={proposal.base_version !== script.current_version}>Apply proposal</Button></form>
                </div>
              </CardContent>
            </Card>
          )}

          <h2 className="text-sm font-semibold text-fg">Scenes ({scenes.length}){lockedCount ? <span className="ml-2 text-xs font-normal text-fg-subtle">{lockedCount} locked — AI edits never change locked scenes</span> : null}</h2>
          <ol className="space-y-3">
            {scenes.map((s, i) => (
              <li key={s.id}>
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="grid size-7 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-fg">{i + 1}</span>
                        <span className="font-medium text-fg">{s.scene_title}</span>
                        <Badge>{labelOf(SCRIPT_SECTIONS, s.section)}</Badge>
                        <Badge>{s.estimated_duration_seconds}s est.</Badge>
                        <span className="text-[11px] text-fg-subtle">speech ≈ {estimateSpeechSeconds(s.spoken_text)}s</span>
                        {s.is_locked && <Badge tone="info">🔒 Locked</Badge>}
                      </div>
                      <div className="flex flex-wrap">
                        <SceneButton scriptId={id} sceneId={s.id} cmd="up" label="↑" disabled={i === 0} />
                        <SceneButton scriptId={id} sceneId={s.id} cmd="down" label="↓" disabled={i === scenes.length - 1} />
                        <SceneButton scriptId={id} sceneId={s.id} cmd="duplicate" label="Duplicate" />
                        <SceneButton scriptId={id} sceneId={s.id} cmd="add_after" label="+ Add after" />
                        <SceneButton scriptId={id} sceneId={s.id} cmd={s.is_locked ? "unlock" : "lock"} label={s.is_locked ? "Unlock" : "Lock"} />
                        <SceneButton scriptId={id} sceneId={s.id} cmd="delete" label="Delete" danger disabled={s.is_locked || scenes.length <= 1} />
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent><SceneEditForm scene={s} /></CardContent>
                </Card>
              </li>
            ))}
          </ol>

          <Card>
            <CardHeader><CardTitle>Script details and sections</CardTitle><CardDescription>Structured outline. Not every format uses every section.</CardDescription></CardHeader>
            <CardContent>
              <ActionForm action={updateScriptMeta} submitLabel="Save details" pendingLabel="Saving…">
                <input type="hidden" name="scriptId" value={id} />
                <div className="grid gap-4 sm:grid-cols-4">
                  <Field label="Title" name="title" className="sm:col-span-2"><Input name="title" defaultValue={script.title} maxLength={200} /></Field>
                  <Field label="Tone" name="tone"><Input name="tone" defaultValue={script.tone ?? ""} maxLength={80} /></Field>
                  <Field label="Status" name="status"><Select name="status" defaultValue={script.status}><option value="draft">Draft</option><option value="approved">Approved</option><option value="archived">Archived</option></Select></Field>
                </div>
                <Field label="Target duration (s)" name="target_duration_seconds"><Input name="target_duration_seconds" type="number" min={5} max={1800} defaultValue={script.target_duration_seconds} className="max-w-32" /></Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  {SCRIPT_SECTIONS.map((s) => {
                    const key = s.id === "transition" ? "transitions" : s.id;
                    return <Field key={key} label={s.label} name={`section_${key}`}><Textarea name={`section_${key}`} defaultValue={typeof sections[key] === "string" ? (sections[key] as string) : ""} maxLength={5000} className="min-h-16" /></Field>;
                  })}
                </div>
                <Field label="Notes" name="notes"><Textarea name="notes" defaultValue={script.notes ?? ""} maxLength={10000} /></Field>
              </ActionForm>
            </CardContent>
          </Card>
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader><CardTitle>AI tools</CardTitle><CardDescription>Creates a proposal you review before anything changes. Locked scenes are never modified. 1 credit.</CardDescription></CardHeader>
            <CardContent>
              <ActionForm action={proposeEdit} submitLabel="Create proposal" pendingLabel="Script Agent editing…" size="sm">
                <input type="hidden" name="scriptId" value={id} />
                <Field label="Operation" name="op">
                  <Select name="op" defaultValue="rewrite_selection">
                    <option value="rewrite_selection">Rewrite selected scenes</option>
                    <option value="regenerate_section">Regenerate a section</option>
                    <option value="change_tone">Change tone</option>
                    <option value="shorten">Shorten script</option>
                    <option value="expand">Expand script</option>
                  </Select>
                </Field>
                <fieldset>
                  <legend className="mb-1 text-xs text-fg-subtle">Scenes (for “rewrite selected”)</legend>
                  <div className="max-h-40 space-y-1 overflow-y-auto">
                    {scenes.map((s, i) => <label key={s.id} className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" name="sceneIds" value={s.id} disabled={s.is_locked} className="accent-[rgb(var(--color-accent))]" />{i + 1}. {s.scene_title}{s.is_locked ? " 🔒" : ""}</label>)}
                  </div>
                </fieldset>
                <Field label="Section (for “regenerate”)" name="section"><Select name="section" defaultValue="main_development">{SCRIPT_SECTIONS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select></Field>
                <Field label="Tone (for “change tone”)" name="tone"><Input name="tone" maxLength={80} placeholder="warmer, more playful" /></Field>
                <Field label="Instruction" name="instruction"><Textarea name="instruction" maxLength={1000} className="min-h-16" placeholder="e.g. make the example more concrete" /></Field>
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Versions & alternatives</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <ActionForm action={saveScriptVersion} submitLabel="Save version" pendingLabel="Saving…" size="sm" variant="outline" className="space-y-2">
                <input type="hidden" name="scriptId" value={id} />
                <label htmlFor="note" className="sr-only">Version note</label>
                <Input name="note" maxLength={500} placeholder="Version note (optional)" />
              </ActionForm>
              <ActionForm action={generateAlternative} submitLabel="Generate alternative" pendingLabel="Writing an alternative…" size="sm" variant="outline" className="space-y-2">
                <input type="hidden" name="scriptId" value={id} />
                <p className="text-xs text-fg-subtle">Creates a separate script with a different approach; this script and your edits stay untouched. 4 credits.</p>
                <label htmlFor="instructions" className="sr-only">Instructions</label>
                <Input name="instructions" maxLength={1500} placeholder="Direction for the alternative (optional)" />
              </ActionForm>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Quality</CardTitle><CardDescription>Editorial heuristics — not a performance prediction. Never changes the script. 1 credit.</CardDescription></CardHeader>
            <CardContent className="space-y-2">
              {latestReport && <Link href={`/script-lab/scripts/${id}/quality?report=${latestReport.id}`} className="block text-xs text-accent">Latest report: v{latestReport.script_version} · {formatDateTime(latestReport.created_at)}</Link>}
              <ActionForm action={runQualityCheck} submitLabel="Run quality check" pendingLabel="Quality Agent reviewing…" size="sm" variant="outline" className="space-y-2">
                <input type="hidden" name="scriptId" value={id} />
              </ActionForm>
            </CardContent>
          </Card>

          {(rulesApplied.length > 0 || assumptions.length > 0) && (
            <Card>
              <CardHeader><CardTitle>How this script was built</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-xs">
                {rulesApplied.map((r, i) => <p key={i}><Link href={`/script-lab/rules/${r.rule_id}`} className="text-accent">Rule</Link>: <span className="text-fg-muted">{r.how}</span></p>)}
                {assumptions.length > 0 && <p className="text-fg-muted"><span className="text-fg">Assumptions (AI):</span> {assumptions.join(" · ")}</p>}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="space-y-3 pt-4">
              <FeedbackWidget targetType="script" targetId={id} targetVersion={script.current_version} />
              <form action={deleteScript}>
                <input type="hidden" name="scriptId" value={id} />
                <input type="hidden" name="projectId" value={script.project_id} />
                <Button type="submit" variant="ghost" size="sm" className="text-danger">Delete script</Button>
              </form>
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}
