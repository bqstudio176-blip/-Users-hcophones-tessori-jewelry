import type { Metadata } from "next";
import { ActionForm } from "@/components/creative/action-form";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/field";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { createPreference, deletePreference, setPreferenceApproval } from "@/server/actions/creative";
import { FEEDBACK_REASONS, labelOf } from "@/server/creative/catalog";

export const metadata: Metadata = { title: "Feedback & preferences" };

/** Deterministic suggestions from repeated negative reasons. Never applied automatically. */
const SUGGESTIONS: Record<string, { kind: "prefer" | "avoid"; scope: string; statement: string }> = {
  too_long: { kind: "prefer", scope: "length", statement: "Keep scripts tight: cut setup and get to the point faster" },
  too_generic: { kind: "prefer", scope: "style", statement: "Use specific, concrete examples instead of general advice" },
  too_commercial: { kind: "avoid", scope: "cta", statement: "Avoid hard-sell language; keep CTAs low-pressure" },
  wrong_tone: { kind: "prefer", scope: "tone", statement: "Match the strategy tone closely; review tone before generating" },
  needs_more_storytelling: { kind: "prefer", scope: "storytelling", statement: "Build around a short story or personal example" },
  not_relevant: { kind: "prefer", scope: "topic", statement: "Stay close to the strategy's niche and main topic" },
};
const SCOPES = ["tone", "length", "style", "topic", "format", "cta", "storytelling", "other"];

export default async function FeedbackPage() {
  const ctx = await getWorkspaceContext();
  const isAdmin = ctx.role === "owner" || ctx.role === "admin";
  const supabase = await createClient();
  const [{ data: feedback }, { data: prefs }] = await Promise.all([
    supabase.from("script_feedback").select("id, target_type, target_version, rating, reasons, comment, created_at").eq("workspace_id", ctx.workspace.id).order("created_at", { ascending: false }).limit(100),
    supabase.from("creative_preferences").select("id, kind, scope, statement, source, approved, created_at").eq("workspace_id", ctx.workspace.id).order("created_at", { ascending: false }),
  ]);
  const counts = new Map<string, number>();
  for (const f of feedback ?? []) if (f.rating === "not_useful") for (const r of f.reasons as string[]) counts.set(r, (counts.get(r) ?? 0) + 1);
  const existing = new Set((prefs ?? []).map((p) => p.statement));
  const suggestions = [...counts.entries()].filter(([r, n]) => n >= 2 && SUGGESTIONS[r] && !existing.has(SUGGESTIONS[r].statement)).map(([r, n]) => ({ reason: r, n, ...SUGGESTIONS[r] }));

  return (
    <>
      <PageHeader title="Feedback & preferences" description="Your feedback is stored with the exact content version it refers to. Only approved preferences are given to the agents — nothing is learned silently and no model is trained on your data." />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Creative preferences</CardTitle><CardDescription>Approved preferences are added to agent context when relevant. Owners and admins approve.</CardDescription></CardHeader>
            <CardContent className="space-y-4">
              {(prefs ?? []).length === 0 ? <p className="text-sm text-fg-subtle">No preferences yet.</p> : (
                <ul className="space-y-2">
                  {(prefs ?? []).map((p) => (
                    <li key={p.id} className="flex items-start justify-between gap-3 rounded-md border border-line p-3 text-sm">
                      <div>
                        <div className="mb-1 flex flex-wrap gap-1.5"><Badge tone={p.kind === "prefer" ? "success" : "warning"}>{p.kind}</Badge><Badge>{p.scope}</Badge>{p.approved ? <Badge tone="success">Active</Badge> : <Badge>Pending approval</Badge>}{p.source === "feedback_suggestion" && <Badge tone="info">From feedback</Badge>}</div>
                        <p className="text-fg">{p.statement}</p>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {isAdmin && <form action={setPreferenceApproval}><input type="hidden" name="preferenceId" value={p.id} /><input type="hidden" name="approved" value={p.approved ? "false" : "true"} /><Button type="submit" size="sm" variant="outline">{p.approved ? "Pause" : "Approve"}</Button></form>}
                        <form action={deletePreference}><input type="hidden" name="preferenceId" value={p.id} /><Button type="submit" size="sm" variant="ghost" className="text-danger">Delete</Button></form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <ActionForm action={createPreference} submitLabel="Add preference" pendingLabel="Saving…" size="sm" className="grid gap-3 border-t border-line pt-4 sm:grid-cols-[7rem_9rem_1fr]">
                <Field label="Type" name="kind"><Select name="kind" defaultValue="prefer"><option value="prefer">Prefer</option><option value="avoid">Avoid</option></Select></Field>
                <Field label="Scope" name="scope"><Select name="scope" defaultValue="style">{SCOPES.map((s) => <option key={s} value={s}>{s}</option>)}</Select></Field>
                <Field label="Statement" name="statement"><Input name="statement" maxLength={300} placeholder="e.g. Open with a personal example" /></Field>
              </ActionForm>
            </CardContent>
          </Card>
          {suggestions.length > 0 && (
            <Card>
              <CardHeader><CardTitle>Suggested from your feedback</CardTitle><CardDescription>Based on reasons you selected at least twice. Nothing changes unless you add it.</CardDescription></CardHeader>
              <CardContent>
                <ul className="space-y-3">
                  {suggestions.map((s) => (
                    <li key={s.reason} className="rounded-md border border-line p-3 text-sm">
                      <p className="text-xs text-fg-subtle">“{labelOf(FEEDBACK_REASONS, s.reason)}” selected {s.n} times</p>
                      <ActionForm action={createPreference} submitLabel="Add as preference" size="sm" variant="outline" className="mt-2 flex items-center justify-between gap-3">
                        <input type="hidden" name="kind" value={s.kind} /><input type="hidden" name="scope" value={s.scope} /><input type="hidden" name="statement" value={s.statement} /><input type="hidden" name="source" value="feedback_suggestion" />
                        <span className="text-fg">{s.kind === "avoid" ? "Avoid: " : "Prefer: "}{s.statement}</span>
                      </ActionForm>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
        </div>
        <Card>
          <CardHeader><CardTitle>Feedback history</CardTitle><CardDescription>Most recent 100.</CardDescription></CardHeader>
          <CardContent>
            {(feedback ?? []).length === 0 ? <EmptyState title="No feedback yet" description="Rate ideas, hooks, scripts and quality reports to steer future suggestions." /> : (
              <ul className="divide-y divide-line">
                {(feedback ?? []).map((f) => (
                  <li key={f.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5"><Badge tone={f.rating === "useful" ? "success" : "warning"}>{f.rating === "useful" ? "Useful" : "Not useful"}</Badge><span className="text-fg">{f.target_type.replace("_", " ")}{f.target_version != null ? ` · v${f.target_version}` : ""}</span><span className="ml-auto text-xs text-fg-subtle">{formatDateTime(f.created_at)}</span></div>
                    {(f.reasons as string[]).length > 0 && <p className="mt-1 text-xs text-fg-muted">{(f.reasons as string[]).map((r) => labelOf(FEEDBACK_REASONS, r)).join(" · ")}</p>}
                    {f.comment && <p className="mt-1 text-xs text-fg-muted">“{f.comment}”</p>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
