import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdjustCreditsForm } from "@/components/app/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, Stat } from "@/components/ui/states";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { auditLabel, formatDate, formatDateTime, formatNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { uuidSchema } from "@/lib/validation";
import type { AuditLog, UsageTransaction } from "@/lib/types";

export const metadata: Metadata = { title: "Workspace" };

export default async function AdminWorkspaceDetail({ params }: { params: Promise<{ id: string }> }) {
  await requirePlatformAdmin();
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const supabase = await createClient();

  const [ws, members, sub, credits, ledger, audit] = await Promise.all([
    supabase.from("workspaces").select("id, name, slug, created_at").eq("id", id).maybeSingle(),
    supabase.from("workspace_members").select("role, profile:profiles!workspace_members_user_id_fkey(email, full_name)").eq("workspace_id", id),
    supabase.from("subscriptions").select("plan_id, status, current_period_end").eq("workspace_id", id).maybeSingle(),
    supabase.from("usage_credits").select("balance").eq("workspace_id", id).maybeSingle(),
    supabase.from("usage_transactions").select("*").eq("workspace_id", id).order("created_at", { ascending: false }).limit(20),
    supabase.from("audit_logs").select("*").eq("workspace_id", id).order("created_at", { ascending: false }).limit(20),
  ]);
  if (!ws.data) notFound();

  return (
    <>
      <PageHeader title={ws.data.name} description={`${ws.data.slug} · created ${formatDate(ws.data.created_at)}`} />
      <div className="grid gap-4 sm:grid-cols-3">
        <Card><CardContent><Stat label="Plan" value={<span className="capitalize">{sub.data?.plan_id ?? "—"}</span>} hint={sub.data ? `${sub.data.status} · renews ${formatDate(sub.data.current_period_end)}` : undefined} /></CardContent></Card>
        <Card><CardContent><Stat label="Credit balance" value={formatNumber(credits.data?.balance ?? 0)} /></CardContent></Card>
        <Card><CardContent><Stat label="Members" value={(members.data ?? []).length} /></CardContent></Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Adjust credits</CardTitle><CardDescription>Writes an adjustment to the ledger and the audit log.</CardDescription></CardHeader>
          <CardContent><AdjustCreditsForm workspaceId={id} /></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Members</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {((members.data ?? []) as unknown as { role: string; profile: { email: string; full_name: string | null } | null }[]).map((m, i) => (
                <li key={i} className="flex justify-between"><span className="text-fg">{m.profile?.full_name || m.profile?.email}</span><span className="capitalize text-fg-muted">{m.role}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Ledger</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs">
              {((ledger.data ?? []) as UsageTransaction[]).map((t) => (
                <li key={t.id} className="flex justify-between gap-3"><span className="truncate text-fg-muted">{t.reason}</span><span className="tabular-nums text-fg">{t.amount > 0 ? "+" : ""}{t.amount} → {t.balance_after}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Audit log</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-xs">
              {((audit.data ?? []) as AuditLog[]).map((a) => (
                <li key={a.id} className="flex justify-between gap-3"><span className="text-fg">{auditLabel(a.action)}</span><span className="text-fg-subtle">{formatDateTime(a.created_at)}</span></li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
