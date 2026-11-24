import type { Metadata } from "next";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, PageHeader } from "@/components/ui/states";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { formatDate, formatNumber } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Workspaces" };

interface Row {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  owner: { email: string } | null;
  workspace_members: { count: number }[];
  subscriptions: { plan_id: string; status: string } | null;
  usage_credits: { balance: number } | null;
  social_accounts: { status: string } | null;
}

export default async function AdminWorkspaces() {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, slug, created_at, owner:profiles!workspaces_owner_id_fkey(email), workspace_members(count), subscriptions(plan_id, status), usage_credits(balance), social_accounts(status)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not load workspaces: ${error.message}`);
  const rows = (data ?? []) as unknown as Row[];

  return (
    <>
      <PageHeader title="Workspaces" description={`${rows.length} most recent (max 200).`} />
      {rows.length === 0 ? <EmptyState title="No workspaces yet" /> : (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line text-xs text-fg-subtle">
              <tr>{["Workspace", "Owner", "Plan", "Members", "Credits", "Instagram", "Created"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((w) => (
                <tr key={w.id} className="hover:bg-surface-2">
                  <td className="px-4 py-3"><Link href={`/admin/workspaces/${w.id}`} className="font-medium text-fg hover:text-accent">{w.name}</Link><p className="text-xs text-fg-subtle">{w.slug}</p></td>
                  <td className="px-4 py-3 text-fg-muted">{w.owner?.email ?? "—"}</td>
                  <td className="px-4 py-3">{w.subscriptions ? <><span className="capitalize text-fg">{w.subscriptions.plan_id}</span> <Badge className="ml-1 capitalize">{w.subscriptions.status}</Badge></> : "—"}</td>
                  <td className="px-4 py-3 tabular-nums text-fg">{w.workspace_members[0]?.count ?? 0}</td>
                  <td className="px-4 py-3 tabular-nums text-fg">{formatNumber(w.usage_credits?.balance ?? 0)}</td>
                  <td className="px-4 py-3 capitalize text-fg-muted">{w.social_accounts?.status ?? "none"}</td>
                  <td className="whitespace-nowrap px-4 py-3 text-fg-subtle">{formatDate(w.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
