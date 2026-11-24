import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, Stat } from "@/components/ui/states";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { auditLabel, formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog } from "@/lib/types";

export const metadata: Metadata = { title: "Overview" };

export default async function AdminOverview() {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const since = new Date(Date.now() - 7 * 86400_000).toISOString();
  const [ws, users, newUsers, subs, social, recent] = await Promise.all([
    supabase.from("workspaces").select("id", { count: "exact", head: true }),
    supabase.from("profiles").select("id", { count: "exact", head: true }),
    supabase.from("profiles").select("id", { count: "exact", head: true }).gte("created_at", since),
    supabase.from("subscriptions").select("plan_id, status"),
    supabase.from("social_accounts").select("status"),
    supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(10),
  ]);
  for (const r of [ws, users, newUsers, subs, social, recent]) if (r.error) throw new Error(`Admin query failed: ${r.error.message}`);

  const byPlan = new Map<string, number>();
  for (const s of subs.data ?? []) byPlan.set(s.plan_id, (byPlan.get(s.plan_id) ?? 0) + 1);
  const connected = (social.data ?? []).filter((s) => s.status === "connected").length;

  return (
    <>
      <PageHeader title="Platform overview" description="Read-only view across all tenants." />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent><Stat label="Workspaces" value={ws.count ?? 0} /></CardContent></Card>
        <Card><CardContent><Stat label="Users" value={users.count ?? 0} hint={`${newUsers.count ?? 0} in the last 7 days`} /></CardContent></Card>
        <Card><CardContent><Stat label="Subscriptions" value={(subs.data ?? []).length} hint={[...byPlan].map(([p, n]) => `${p}: ${n}`).join(" · ") || "—"} /></CardContent></Card>
        <Card><CardContent><Stat label="Instagram connected" value={connected} hint={`${(social.data ?? []).length} total connections`} /></CardContent></Card>
      </div>
      <Card className="mt-4">
        <CardHeader><CardTitle>Latest system activity</CardTitle></CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {(recent.data as AuditLog[]).map((a) => (
              <li key={a.id} className="flex justify-between gap-4">
                <span className="text-fg">{auditLabel(a.action)}{a.workspace_id && <Link href={`/admin/workspaces/${a.workspace_id}`} className="ml-2 text-xs text-accent">workspace</Link>}</span>
                <time className="text-xs text-fg-subtle" dateTime={a.created_at}>{formatRelative(a.created_at)}</time>
              </li>
            ))}
          </ul>
          <Link href="/admin/activity" className="mt-4 inline-block text-xs text-accent hover:text-accent-hover">All activity</Link>
        </CardContent>
      </Card>
    </>
  );
}
