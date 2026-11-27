import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState, Stat } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDate, formatDateTime, formatNumber, formatPrice } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { Plan, Subscription, UsageTransaction } from "@/lib/types";

export const metadata: Metadata = { title: "Plan & usage" };

const TYPE_LABEL: Record<UsageTransaction["type"], string> = {
  grant: "Grant",
  consume: "Usage",
  refund: "Refund",
  adjustment: "Adjustment",
  expire: "Expiry",
};

export default async function BillingPage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const wsId = ctx.workspace.id;

  const [subRes, plansRes, creditsRes, ledgerRes] = await Promise.all([
    supabase.from("subscriptions").select("*").eq("workspace_id", wsId).maybeSingle(),
    supabase.from("plans").select("*").order("sort_order"),
    supabase.from("usage_credits").select("balance").eq("workspace_id", wsId).maybeSingle(),
    supabase.from("usage_transactions").select("*").eq("workspace_id", wsId).order("created_at", { ascending: false }).limit(50),
  ]);
  for (const r of [subRes, plansRes, creditsRes, ledgerRes]) if (r.error) throw new Error(`Could not load billing data: ${r.error.message}`);

  const sub = subRes.data as Subscription | null;
  const plans = (plansRes.data ?? []) as Plan[];
  const current = plans.find((p) => p.id === sub?.plan_id);
  const ledger = (ledgerRes.data ?? []) as UsageTransaction[];

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Current plan</CardTitle>
          <CardDescription>Billing is not live yet. Plans and credits are tracked so usage can be metered from day one.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-3">
          <Stat label="Plan" value={current?.name ?? "—"} hint={sub ? <span className="capitalize">{sub.status.replace("_", " ")}</span> : undefined} />
          <Stat label="Credit balance" value={formatNumber((creditsRes.data as { balance: number } | null)?.balance ?? 0)} hint={current ? `${formatNumber(current.monthly_credits)} / month included` : undefined} />
          <Stat label="Current period" value={sub ? formatDate(sub.current_period_end) : "—"} hint={sub ? `Started ${formatDate(sub.current_period_start)}` : undefined} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Plans</CardTitle>
          <CardDescription>Self-serve upgrades will be enabled when payments launch.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-3">
          {plans.map((p) => (
            <div key={p.id} className={`rounded-md border p-4 ${p.id === sub?.plan_id ? "border-accent bg-accent/5" : "border-line"}`}>
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-fg">{p.name}</p>
                {p.id === sub?.plan_id && <Badge tone="accent">Current</Badge>}
              </div>
              <p className="mt-1 text-xl font-semibold text-fg">{p.price_cents === 0 ? "Free" : formatPrice(p.price_cents, p.currency)}<span className="text-xs font-normal text-fg-subtle">{p.price_cents ? " /mo" : ""}</span></p>
              <ul className="mt-3 space-y-1 text-xs text-fg-muted">
                {p.features.map((f) => <li key={f}>· {f}</li>)}
              </ul>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credit ledger</CardTitle>
          <CardDescription>Append-only record of every credit movement (latest 50).</CardDescription>
        </CardHeader>
        <CardContent>
          {ledger.length === 0 ? (
            <EmptyState title="No transactions yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-subtle">
                  <tr>
                    <th scope="col" className="pb-2 font-medium">Date</th>
                    <th scope="col" className="pb-2 font-medium">Type</th>
                    <th scope="col" className="pb-2 font-medium">Reason</th>
                    <th scope="col" className="pb-2 text-right font-medium">Amount</th>
                    <th scope="col" className="pb-2 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {ledger.map((t) => (
                    <tr key={t.id}>
                      <td className="whitespace-nowrap py-2 pr-4 text-fg-subtle">{formatDateTime(t.created_at)}</td>
                      <td className="py-2 pr-4"><Badge tone={t.amount > 0 ? "success" : "neutral"}>{TYPE_LABEL[t.type]}</Badge></td>
                      <td className="py-2 pr-4 text-fg">{t.reason}</td>
                      <td className={`py-2 text-right tabular-nums ${t.amount > 0 ? "text-success" : "text-fg"}`}>{t.amount > 0 ? "+" : ""}{formatNumber(t.amount)}</td>
                      <td className="py-2 text-right tabular-nums text-fg-muted">{formatNumber(t.balance_after)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <Alert tone="info" className="mt-4">Credits are consumed by video analyses (Analyze) and by Script Lab AI agents. AI agent runs are charged only when they return validated output — failed or rejected runs are free. See Script Lab → AI usage for a per-run breakdown.</Alert>
        </CardContent>
      </Card>
    </>
  );
}
