import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ProcessingView } from "@/components/analyze/processing-view";
import { ReportNotesForm } from "@/components/analyze/report-notes-form";
import { RequestAnalysisForm } from "@/components/analyze/request-analysis-form";
import { SceneTimeline, type TimelineScene } from "@/components/analyze/scene-timeline";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState, PageHeader, Stat } from "@/components/ui/states";
import { can } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime, formatDuration } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import { ReportSections, type Observation } from "@/server/analysis/ai/schemas";
import { signMediaUrls } from "@/server/media-urls";

export const metadata: Metadata = { title: "Analysis" };

const ts = (sec: number | null) => (sec === null ? "—" : `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`);

function Observed({ items, empty = "None observed." }: { items: Observation[]; empty?: string }) {
  if (items.length === 0) return <p className="text-xs text-fg-subtle">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {items.map((o, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className="w-10 shrink-0 tabular-nums text-xs text-accent">{ts(o.timestamp_sec)}</span>
          <span className="text-fg">{o.observation}</span>
        </li>
      ))}
    </ul>
  );
}

function Interpretation({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 rounded-md border border-accent/25 bg-accent/5 p-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-accent">AI interpretation</p>
      <div className="text-sm text-fg">{children}</div>
    </div>
  );
}

function Section({ id, title, description, children }: { id: string; title: string; description?: string; children: ReactNode }) {
  return (
    <Card id={id}>
      <CardHeader><CardTitle>{title}</CardTitle>{description && <CardDescription>{description}</CardDescription>}</CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const Label = ({ children }: { children: ReactNode }) => <h4 className="mb-2 mt-4 text-xs font-medium text-fg-muted first:mt-0">{children}</h4>;

export default async function AnalysisPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await getWorkspaceContext();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();
  const { data: a } = await supabase
    .from("video_analyses")
    .select("*, reference:content_references(id, title, url, source_type, author_name, media_path, media_status, thumbnail_path, thumbnail_url), analysis_jobs(id, status, current_step, steps, attempts, max_attempts, last_error, cancel_requested, run_after)")
    .eq("id", id)
    .maybeSingle();
  if (!a) notFound();
  const ref = (Array.isArray(a.reference) ? a.reference[0] : a.reference) as { id: string; title: string; url: string | null; source_type: string; author_name: string | null; media_path: string | null; media_status: string; thumbnail_path: string | null; thumbnail_url: string | null };
  const job = Array.isArray(a.analysis_jobs) ? a.analysis_jobs[0] : a.analysis_jobs;
  const canCancel = a.requested_by === ctx.user.id || can(ctx.role, "settings.update");
  const { data: cost } = await supabase.rpc("analysis_credit_cost");

  const header = (
    <PageHeader
      title={ref.title}
      description={<>Analysis requested {formatDateTime(a.created_at)}{a.completed_at ? ` · finished ${formatDateTime(a.completed_at)}` : ""}</>}
      actions={<Link href={`/discover/references/${ref.id}`} className={buttonClasses("outline")}>Open in Discover</Link>}
    />
  );

  if (a.status === "queued" || a.status === "processing") {
    const { data: logs } = job ? await supabase.from("analysis_job_logs").select("id, level, step, message, created_at").eq("job_id", job.id).order("id", { ascending: false }).limit(25) : { data: [] };
    return (
      <>
        {header}
        <ProcessingView analysisId={a.id} canCancel={canCancel} initial={{ status: a.status, error: a.error, job: job ?? null, logs: (logs ?? []).reverse() }} />
      </>
    );
  }

  if (a.status === "failed" || a.status === "canceled") {
    const { data: logs } = job ? await supabase.from("analysis_job_logs").select("id, level, step, message, created_at").eq("job_id", job.id).order("id").limit(50) : { data: [] };
    return (
      <>
        {header}
        <ErrorState
          title={a.status === "failed" ? "This analysis failed" : "This analysis was cancelled"}
          description={<>{a.error ?? "No further details."} {a.credits_refunded ? "Credits were refunded." : ""}</>}
          action={ref.media_status === "uploaded" ? <RequestAnalysisForm referenceId={ref.id} cost={Number(cost ?? 5)} label="Try again" /> : undefined}
        />
        {(logs ?? []).length > 0 && (
          <Card className="mt-4">
            <CardHeader><CardTitle>Processing log</CardTitle></CardHeader>
            <CardContent>
              <ul className="space-y-1 font-mono text-[11px]">
                {(logs ?? []).map((l) => <li key={l.id} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-fg-muted"}>{new Date(l.created_at).toLocaleTimeString()} {l.step ? `[${l.step}] ` : ""}{l.message}</li>)}
              </ul>
            </CardContent>
          </Card>
        )}
      </>
    );
  }

  // Completed → report
  const [{ data: report }, { data: scenes }, { data: transcript }] = await Promise.all([
    supabase.from("analysis_reports").select("*").eq("analysis_id", id).maybeSingle(),
    supabase.from("detected_scenes").select("*").eq("analysis_id", id).order("idx"),
    supabase.from("transcripts").select("provider, model, language, transcript_segments(idx, start_ms, end_ms, text)").eq("analysis_id", id).maybeSingle(),
  ]);
  const parsed = ReportSections.safeParse(report?.sections);
  if (!report || !parsed.success) {
    return (<>{header}<ErrorState title="Report unavailable" description="The stored report could not be read. Re-run the analysis." action={<RequestAnalysisForm referenceId={ref.id} cost={Number(cost ?? 5)} label="Re-run analysis" />} /></>);
  }
  const s = parsed.data;
  const meta = a.media_metadata as { durationSeconds: number; video?: { width: number; height: number; fps: number | null; codec: string } | null; audio?: { codec: string } | null; container?: string };
  const urls = await signMediaUrls([ref.media_status === "uploaded" ? ref.media_path : null, ...(scenes ?? []).map((sc) => sc.frame_path)]);
  const segments = ((transcript?.transcript_segments ?? []) as { idx: number; start_ms: number; end_ms: number; text: string }[]).sort((x, y) => x.idx - y.idx);
  const timeline: TimelineScene[] = (scenes ?? []).map((sc) => {
    const v = sc.visual as { description?: string; camera_framing?: string; text_overlays?: string[] };
    return { idx: sc.idx, start_ms: sc.start_ms, end_ms: sc.end_ms, frameUrl: sc.frame_path ? urls[sc.frame_path] ?? null : null, description: v.description ?? null, framing: v.camera_framing ?? null, textOverlays: v.text_overlays ?? [], transcript: sc.transcript_excerpt, purpose: sc.purpose, editingNotes: sc.editing_notes, visualAnalyzed: sc.visual_analyzed, score: sc.detection_score === null ? null : Number(sc.detection_score) };
  });
  const firstFrame = timeline[0]?.frameUrl ?? null;

  return (
    <>
      {header}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <a href={`/api/analyses/${id}/export?format=md`} className={buttonClasses("outline", "sm")}>Export Markdown</a>
        <a href={`/api/analyses/${id}/export?format=json`} className={buttonClasses("outline", "sm")}>Export JSON</a>
        <RequestAnalysisForm referenceId={ref.id} cost={Number(cost ?? 5)} label="Re-run analysis" variant="outline" />
        <Button variant="outline" size="sm" disabled aria-disabled title="Available when Script Lab launches in Phase 3">Send to Script Lab · Phase 3</Button>
      </div>

      <Alert tone="info" className="mb-6">
        Observed facts come from the transcript, {s.inputs.framesAnalyzed} of {s.inputs.scenesTotal} representative scene frames, and measured scene detection. Highlighted blocks are AI interpretations. No audience or performance data was used{s.inputs.transcript !== "completed" ? ` · Transcript ${s.inputs.transcript.replace("_", " ")}` : ""}.
      </Alert>

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card><CardContent><Stat label="Duration" value={formatDuration(meta.durationSeconds)} hint={meta.video ? `${meta.video.width}×${meta.video.height}${meta.video.fps ? ` · ${meta.video.fps} fps` : ""}` : undefined} /></CardContent></Card>
        <Card><CardContent><Stat label="Scenes" value={s.editing.measured.sceneCount} hint={`avg ${s.editing.measured.averageSceneSeconds}s`} /></CardContent></Card>
        <Card><CardContent><Stat label="Cuts per minute" value={s.editing.measured.cutsPerMinute} hint="measured" /></CardContent></Card>
        <Card><CardContent><Stat label="Speech coverage" value={s.editing.measured.speechCoverage === null ? "—" : `${Math.round(s.editing.measured.speechCoverage * 100)}%`} hint={transcript ? `${transcript.provider}/${transcript.model}` : "no transcript"} /></CardContent></Card>
        <Card><CardContent><Stat label="Hook type" value={<span className="text-lg capitalize">{s.hook.hook_type.replace(/_/g, " ")}</span>} hint={`~${s.hook.estimated_hook_duration_sec.toFixed(1)}s`} /></CardContent></Card>
      </div>

      <Section id="timeline" title="Video, scenes and transcript" description="Scene boundaries come from ffmpeg scene detection. Click a scene or transcript line to jump to it.">
        <SceneTimeline videoUrl={ref.media_path ? urls[ref.media_path] ?? null : null} poster={firstFrame} durationMs={Math.round(meta.durationSeconds * 1000)} scenes={timeline} segments={segments} />
      </Section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section id="summary" title="Content summary">
          <dl className="space-y-2 text-sm">
            <div><dt className="text-xs text-fg-subtle">Main topic</dt><dd className="text-fg">{s.summary.main_topic}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Intended audience</dt><dd className="text-fg">{s.summary.intended_audience ?? "Not inferable from the content"}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Format</dt><dd className="text-fg">{s.summary.content_format}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Communication objective</dt><dd className="text-fg">{s.summary.communication_objective}</dd></div>
          </dl>
          <Label>Key takeaways</Label>
          <ul className="list-disc space-y-1 pl-5 text-sm text-fg">{s.summary.key_takeaways.map((k) => <li key={k}>{k}</li>)}</ul>
        </Section>

        <Section id="hook" title="Hook">
          <p className="text-sm text-fg">{s.hook.opening_statement ? <>“{s.hook.opening_statement}”</> : <span className="text-fg-subtle">No opening speech.</span>}</p>
          <div className="mt-2 flex flex-wrap gap-2"><Badge tone="accent" className="capitalize">{s.hook.hook_type.replace(/_/g, " ")}</Badge><Badge>~{s.hook.estimated_hook_duration_sec.toFixed(1)}s</Badge></div>
          <dl className="mt-3 space-y-2 text-sm">
            <div><dt className="text-xs text-fg-subtle">Attention mechanism</dt><dd className="text-fg">{s.hook.attention_mechanism}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Curiosity element</dt><dd className="text-fg">{s.hook.curiosity_element ?? "None identified"}</dd></div>
          </dl>
          <Label>Observed</Label>
          <Observed items={s.hook.evidence} />
          <Interpretation>{s.hook.interpretation}</Interpretation>
        </Section>

        <Section id="storytelling" title="Storytelling">
          <div className="flex flex-wrap gap-2"><Badge tone="accent" className="capitalize">{s.storytelling.narrative_structure.replace(/_/g, " ")}</Badge>{s.storytelling.emotional_elements.map((e) => <Badge key={e}>{e}</Badge>)}</div>
          <dl className="mt-3 space-y-2 text-sm">
            <div><dt className="text-xs text-fg-subtle">Main message</dt><dd className="text-fg">{s.storytelling.main_message}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Development</dt><dd className="text-fg">{s.storytelling.development}</dd></div>
          </dl>
          <Label>Information sequence</Label>
          <Observed items={s.storytelling.information_sequence.map((p) => ({ timestamp_sec: p.timestamp_sec, observation: p.point }))} />
          <Label>Observed</Label>
          <Observed items={s.storytelling.evidence} />
          <Interpretation>{s.storytelling.interpretation}</Interpretation>
        </Section>

        <Section id="retention" title="Retention structure" description="Structural techniques in the content — not measured audience retention.">
          <Label>Structural changes</Label><Observed items={s.retention.structural_changes} />
          <Label>Pattern interruptions</Label><Observed items={s.retention.pattern_interruptions} />
          <Label>Questions</Label><Observed items={s.retention.questions} />
          <Label>Transitions</Label><Observed items={s.retention.transitions} />
          <Label>Narrative progression</Label><p className="text-sm text-fg">{s.retention.narrative_progression}</p>
          <Interpretation>{s.retention.interpretation}</Interpretation>
        </Section>

        <Section id="cta" title="Call to action">
          {s.cta.present ? (
            <>
              <p className="text-sm text-fg">“{s.cta.call_to_action}”</p>
              <div className="mt-2 flex flex-wrap gap-2"><Badge tone="accent" className="capitalize">{s.cta.placement}</Badge><Badge>at {ts(s.cta.timestamp_sec)}</Badge></div>
              <p className="mt-3 text-sm text-fg-muted">Intended response: {s.cta.intended_response ?? "—"}</p>
            </>
          ) : <p className="text-sm text-fg-subtle">No call to action identified.</p>}
          <Label>Observed</Label><Observed items={s.cta.evidence} />
        </Section>

        <Section id="editing" title="Editing">
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-xs text-fg-subtle">Shortest scene</dt><dd className="text-fg">{s.editing.measured.shortestSceneSeconds}s</dd></div>
            <div><dt className="text-xs text-fg-subtle">Longest scene</dt><dd className="text-fg">{s.editing.measured.longestSceneSeconds}s</dd></div>
            <div><dt className="text-xs text-fg-subtle">First cut</dt><dd className="text-fg">{s.editing.measured.firstCutSeconds === null ? "No cuts" : `${s.editing.measured.firstCutSeconds}s`}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Source</dt><dd className="text-fg">Measured by scene detection</dd></div>
          </dl>
          <Label>Visual transitions</Label><Observed items={s.editing.observations.visual_transitions} />
          <dl className="mt-3 space-y-2 text-sm">
            <div><dt className="text-xs text-fg-subtle">Text overlays</dt><dd className="text-fg">{s.editing.observations.text_overlay_usage}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Audio structure</dt><dd className="text-fg">{s.editing.observations.audio_structure}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Pacing</dt><dd className="text-fg">{s.editing.observations.pacing_observations}</dd></div>
          </dl>
          <Interpretation>{s.editing.observations.interpretation}</Interpretation>
        </Section>
      </div>

      <div className="mt-6">
        <Section id="creative" title="Creative opportunities" description="AI suggestions for your own original content — techniques to transfer, not content to copy.">
          <div className="grid gap-6 md:grid-cols-2">
            <div><Label>Alternative hooks</Label><ul className="space-y-2 text-sm">{s.creative.alternative_hooks.map((h) => <li key={h.hook}><p className="text-fg">“{h.hook}”</p><p className="text-xs text-fg-muted">{h.rationale}</p></li>)}</ul></div>
            <div><Label>Storytelling approaches</Label><ul className="space-y-2 text-sm">{s.creative.storytelling_approaches.map((x) => <li key={x.approach}><p className="text-fg">{x.approach}</p><p className="text-xs text-fg-muted">{x.description}</p></li>)}</ul></div>
            <div><Label>Original angles</Label><ul className="space-y-2 text-sm">{s.creative.original_angles.map((x) => <li key={x.angle}><p className="text-fg">{x.angle}</p><p className="text-xs text-fg-muted">{x.why_it_could_work}</p></li>)}</ul></div>
            <div><Label>Recommendations</Label><ul className="list-disc space-y-1 pl-5 text-sm text-fg">{s.creative.recommendations.map((r) => <li key={r}>{r}</li>)}</ul></div>
          </div>
        </Section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Section id="notes" title="Your notes"><ReportNotesForm analysisId={id} notes={report.user_notes} /></Section>
        <Section id="provenance" title="Provenance">
          <dl className="space-y-2 text-xs">
            <div><dt className="text-fg-subtle">Model</dt><dd className="text-fg">{report.model_provider} / {report.model_id}</dd></div>
            <div><dt className="text-fg-subtle">Prompt versions</dt><dd className="text-fg">{Object.values(report.prompt_versions as Record<string, string>).join(", ")}</dd></div>
            <div><dt className="text-fg-subtle">Tokens</dt><dd className="text-fg">{report.input_tokens ?? "—"} in · {report.output_tokens ?? "—"} out</dd></div>
            <div><dt className="text-fg-subtle">Estimated AI cost</dt><dd className="text-fg">{report.cost_usd === null ? "Not available" : `$${Number(report.cost_usd).toFixed(4)}`}</dd></div>
            <div><dt className="text-fg-subtle">Processing time</dt><dd className="text-fg">{report.processing_ms ? `${(report.processing_ms / 1000).toFixed(1)}s` : "—"}</dd></div>
            <div><dt className="text-fg-subtle">Media</dt><dd className="text-fg">{meta.container?.toUpperCase()} · {meta.video?.codec}{meta.audio ? ` / ${meta.audio.codec}` : " · no audio"}</dd></div>
          </dl>
        </Section>
      </div>
    </>
  );
}
