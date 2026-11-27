import { ActionForm } from "@/components/creative/action-form";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { saveRule } from "@/server/actions/creative";
import { OBJECTIVES, RULE_CATEGORIES_LABELS, SCRIPT_FORMATS } from "@/server/creative/catalog";

export interface RuleFormValues {
  id?: string;
  name: string;
  category: string;
  description: string;
  objective: string;
  application_conditions: string[];
  avoidance_conditions: string[];
  example: string;
  recommended_formats: string[];
  objectives: string[];
  complexity_level: string;
  evidence_type: string;
  evidence_note: string | null;
  tags: string[];
}

export const EMPTY_RULE: RuleFormValues = {
  name: "", category: "hook", description: "", objective: "", application_conditions: [], avoidance_conditions: [], example: "",
  recommended_formats: [], objectives: [], complexity_level: "basic", evidence_type: "practitioner_heuristic", evidence_note: null, tags: [],
};

const check = "accent-[rgb(var(--color-accent))]";

export function RuleForm({ values }: { values: RuleFormValues }) {
  return (
    <ActionForm action={saveRule} submitLabel={values.id ? "Save as new version" : "Create rule"} pendingLabel="Saving…"
      footer={!values.id ? <label className="flex items-center gap-2 text-xs text-fg-muted"><input type="checkbox" name="submit" value="1" className={check} /> Submit for approval right away</label> : <p className="text-xs text-fg-subtle">Editing creates a new version; the previous one is kept in history and workspace rules return to pending approval.</p>}>
      {values.id && <input type="hidden" name="ruleId" value={values.id} />}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Name" name="name" className="sm:col-span-2"><Input name="name" defaultValue={values.name} maxLength={120} required /></Field>
        <Field label="Category" name="category"><Select name="category" defaultValue={values.category}>{Object.entries(RULE_CATEGORIES_LABELS).map(([id, l]) => <option key={id} value={id}>{l}</option>)}</Select></Field>
      </div>
      <Field label="Description" name="description"><Textarea name="description" defaultValue={values.description} maxLength={2000} /></Field>
      <Field label="Objective" name="objective"><Input name="objective" defaultValue={values.objective} maxLength={600} /></Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="When to apply (one per line)" name="application_conditions"><Textarea name="application_conditions" defaultValue={values.application_conditions.join("\n")} maxLength={4000} /></Field>
        <Field label="When to avoid (one per line)" name="avoidance_conditions"><Textarea name="avoidance_conditions" defaultValue={values.avoidance_conditions.join("\n")} maxLength={4000} /></Field>
      </div>
      <Field label="Example" name="example"><Textarea name="example" defaultValue={values.example} maxLength={1500} /></Field>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-fg">Recommended formats</legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-5">{SCRIPT_FORMATS.map((f) => <label key={f.id} className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" name="recommended_formats" value={f.id} defaultChecked={values.recommended_formats.includes(f.id)} className={check} />{f.label}</label>)}</div>
      </fieldset>
      <fieldset>
        <legend className="mb-1 text-sm font-medium text-fg">Objectives served <span className="text-xs font-normal text-fg-subtle">(none = any)</span></legend>
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4">{OBJECTIVES.map((o) => <label key={o.id} className="flex items-center gap-2 text-xs text-fg"><input type="checkbox" name="objectives" value={o.id} defaultChecked={values.objectives.includes(o.id)} className={check} />{o.label}</label>)}</div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Complexity" name="complexity_level"><Select name="complexity_level" defaultValue={values.complexity_level}><option value="basic">Basic</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></Select></Field>
        <Field label="Evidence type" name="evidence_type"><Select name="evidence_type" defaultValue={values.evidence_type}><option value="established_principle">Established principle</option><option value="practitioner_heuristic">Practitioner heuristic</option><option value="experimental">Experimental</option></Select></Field>
        <Field label="Tags (comma separated)" name="tags"><Input name="tags" defaultValue={values.tags.join(", ")} maxLength={400} /></Field>
      </div>
      <Field label="Evidence note" name="evidence_note" hint="Required for established principles: name the principle and its source. Never claim data you don't have."><Textarea name="evidence_note" defaultValue={values.evidence_note ?? ""} maxLength={600} className="min-h-16" /></Field>
    </ActionForm>
  );
}
