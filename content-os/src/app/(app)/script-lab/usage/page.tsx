import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "AI usage" };

const AGENT_LABEL: Record<string, string> = { research: "Research", strategy: "Strategy", hook: "Hook", script: "Script", script_edit: "Script edit", quality: "Quality" };

export default async function UsagePage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();
  const [{ data: runs }, { data: pricing }] = await Promise.all([
    supabase.from("ai_agent_runs").select("id, agent, status, model, prompt_version, input_tokens, output_tokens, duration_ms, cost_usd, credits_charged, error, created_at").eq("workspace_id", ctx.workspace.id).gte("created_at", since).order("created_at", { ascending: false }).limit(200),
    supabase.from("ai_agent_pricing").select("agent, credits").order("credits"),
  ]);
  const list = runs ?? [];
  const ok = list.filter((r) => r.status === "succeeded");
  const credits = list.reduce((a, r) => a + r.credits_charged, 0);
  const tokens = list.reduce((a, r) => a + (r.input_tokens ?? 0) + (r.output_tokens ?? 0), 0);
  const cost = list.reduce((a, r) => a + Number(r.cost_usd ?? 0), 0);

  return (
    <>
      <PageHeader title="AI usage" description="Every agent run in the last 30 days. Credits are charged only for runs that produce validated output; failed or rejected runs are free." />
      <div className="mb-6 grid gap-3 sm:grid-cols-4">
        {[["Runs", list.length], ["Succeeded", ok.length], ["Credits charged", credits], ["Tokens", tokens.toLocaleString()]].map(([l, v]) => (
          <Card key={String(l)}><CardContent className="pt-4"><p className="text-xs text-fg-subtle">{l}</p><p className="text-2xl font-semibold tabular-nums text-fg">{v}</p></CardContent></Card>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_16rem]">
        <Card>
          <CardHeader><CardTitle>Runs</CardTitle><CardDescription>Provider cost (estimated from reported tokens): ${cost.toFixed(4)}</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto">
            {list.length === 0 ? <EmptyState title="No AI runs yet" description="Generate recommendations, hooks or scripts to see usage here." /> : (
              <table className="w-full text-left text-xs">
                <thead className="text-fg-subtle"><tr><th className="py-2 pr-3">When</th><th className="pr-3">Agent</th><th className="pr-3">Status</th><th className="pr-3">Model · prompt</th><th className="pr-3 text-right">Tokens in/out</th><th className="pr-3 text-right">Time</th><th className="text-right">Credits</th></tr></thead>
                <tbody className="divide-y divide-line">
                  {list.map((r) => (
                    <tr key={r.id} className="text-fg-muted">
                      <td className="py-2 pr-3 whitespace-nowrap">{formatDateTime(r.created_at)}</td>
                      <td className="pr-3 text-fg">{AGENT_LABEL[r.agent] ?? r.agent}</td>
                      <td className="pr-3"><Badge tone={r.status === "succeeded" ? "success" : "warning"}>{r.status.replace("_", " ")}</Badge>{r.error && <span className="ml-1" title={r.error}>ⓘ</span>}</td>
                      <td className="pr-3">{r.model ?? "—"} · {r.prompt_version ?? "—"}</td>
                      <td className="pr-3 text-right tabular-nums">{r.input_tokens ?? 0}/{r.output_tokens ?? 0}</td>
                      <td className="pr-3 text-right tabular-nums">{r.duration_ms != null ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}</td>
                      <td className="text-right tabular-nums text-fg">{r.credits_charged}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Credit prices</CardTitle></CardHeader>
          <CardContent><ul className="space-y-1 text-sm">{(pricing ?? []).map((p) => <li key={p.agent} className="flex justify-between"><span className="text-fg-muted">{AGENT_LABEL[p.agent] ?? p.agent}</span><span className="tabular-nums text-fg">{p.credits}</span></li>)}</ul></CardContent>
        </Card>
      </div>
    </>
  );
}
