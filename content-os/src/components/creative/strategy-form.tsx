import { ActionForm } from "@/components/creative/action-form";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { OBJECTIVES, PLATFORMS, SCRIPT_FORMATS } from "@/server/creative/catalog";
import { saveStrategy } from "@/server/actions/creative";

export interface StrategyValues {
  id?: string;
  name?: string;
  niche?: string | null;
  target_audience?: string | null;
  objective?: string;
  main_topic?: string | null;
  tone?: string | null;
  platform?: string;
  preferred_format?: string;
  duration_seconds?: number;
  reference_ids?: string[];
  manual_topics?: string[];
  restrictions?: string | null;
  desired_cta?: string | null;
  use_content_history?: boolean;
}

export function StrategyForm({ projectId, values, references, defaults }: { projectId: string; values: StrategyValues; references: { id: string; title: string; analyzed: boolean }[]; defaults: { niche?: string | null; tone?: string | null } }) {
  const selected = new Set(values.reference_ids ?? []);
  return (
    <ActionForm action={saveStrategy} submitLabel={values.id ? "Save strategy" : "Create strategy"} pendingLabel="Saving…" className="space-y-6">
      <input type="hidden" name="projectId" value={projectId} />
      {values.id && <input type="hidden" name="strategyId" value={values.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Strategy name" name="name"><Input name="name" required maxLength={120} defaultValue={values.name ?? ""} /></Field>
        <Field label="Industry or niche" name="niche"><Input name="niche" maxLength={120} defaultValue={values.niche ?? defaults.niche ?? ""} /></Field>
      </div>
      <Field label="Target audience" name="target_audience" hint="Who should this content serve? Be specific."><Textarea name="target_audience" maxLength={1000} defaultValue={values.target_audience ?? ""} hasHint className="min-h-16" /></Field>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Content objective" name="objective">
          <Select name="objective" defaultValue={values.objective ?? "educate"}>{OBJECTIVES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
        </Field>
        <Field label="Platform" name="platform">
          <Select name="platform" defaultValue={values.platform ?? "instagram"}>{PLATFORMS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
        </Field>
        <Field label="Preferred format" name="preferred_format">
          <Select name="preferred_format" defaultValue={values.preferred_format ?? "instagram_reel"}>{SCRIPT_FORMATS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</Select>
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Main topic" name="main_topic"><Input name="main_topic" maxLength={300} defaultValue={values.main_topic ?? ""} /></Field>
        <Field label="Communication tone" name="tone"><Input name="tone" maxLength={80} defaultValue={values.tone ?? defaults.tone ?? ""} placeholder="friendly, direct" /></Field>
        <Field label="Estimated duration (seconds)" name="duration_seconds"><Input name="duration_seconds" type="number" min={5} max={1800} defaultValue={values.duration_seconds ?? 45} /></Field>
      </div>
      <Field label="Additional topics" name="manual_topics" hint="Comma-separated, up to 10."><Input name="manual_topics" maxLength={1000} defaultValue={(values.manual_topics ?? []).join(", ")} hasHint /></Field>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-fg">Reference materials</legend>
        <p className="mb-2 text-xs text-fg-subtle">Analyzed references give the Research Agent observed facts to work from. Up to 10.</p>
        {references.length === 0 ? <p className="text-xs text-fg-subtle">No references in your library yet.</p> : (
          <div className="grid max-h-56 gap-1 overflow-y-auto sm:grid-cols-2">
            {references.map((r) => (
              <label key={r.id} className="flex items-center gap-2 text-sm text-fg">
                <input type="checkbox" name="reference_ids" value={r.id} defaultChecked={selected.has(r.id)} className="accent-[rgb(var(--color-accent))]" />
                <span className="truncate">{r.title}</span>
                {!r.analyzed && <span className="text-[10px] text-fg-subtle">(not analyzed)</span>}
              </label>
            ))}
          </div>
        )}
      </fieldset>
      <Checkbox name="use_content_history" label="Use workspace content history" description="Also consider your most relevant analyzed references and previous scripts (relevance-filtered, this workspace only)." defaultChecked={values.use_content_history ?? true} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Restrictions" name="restrictions" hint="Claims, words or topics to avoid."><Textarea name="restrictions" maxLength={2000} defaultValue={values.restrictions ?? ""} hasHint className="min-h-16" /></Field>
        <Field label="Desired CTA" name="desired_cta"><Input name="desired_cta" maxLength={300} defaultValue={values.desired_cta ?? ""} placeholder="Save this / Follow for part 2" /></Field>
      </div>
    </ActionForm>
  );
}
