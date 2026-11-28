import type { Metadata } from "next";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { auditLabel, formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog } from "@/lib/types";

export const metadata: Metadata = { title: "Activity" };

export default async function AdminActivity() {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(`Could not load activity: ${error.message}`);
  return (
    <>
      <PageHeader title="System activity" description="Latest 200 audited events across all tenants." />
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-fg-subtle">
            <tr>{["Event", "Workspace", "Actor", "Details", "When"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {(data as AuditLog[]).map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2 text-fg">{auditLabel(a.action)}</td>
                <td className="px-4 py-2">{a.workspace_id ? <Link className="text-xs text-accent" href={`/admin/workspaces/${a.workspace_id}`}>{a.workspace_id.slice(0, 8)}</Link> : <span className="text-xs text-fg-subtle">—</span>}</td>
                <td className="px-4 py-2 font-mono text-xs text-fg-muted">{a.actor_id?.slice(0, 8) ?? "system"}</td>
                <td className="max-w-xs truncate px-4 py-2 font-mono text-[11px] text-fg-subtle">{JSON.stringify(a.metadata)}</td>
                <td className="whitespace-nowrap px-4 py-2 text-xs text-fg-subtle">{formatDateTime(a.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
