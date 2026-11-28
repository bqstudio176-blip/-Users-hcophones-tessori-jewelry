import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { requirePlatformAdmin } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Users" };

export default async function AdminUsers() {
  await requirePlatformAdmin();
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("id, email, full_name, is_platform_admin, created_at, workspace_members(count)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Could not load users: ${error.message}`);
  const rows = (data ?? []) as unknown as { id: string; email: string; full_name: string | null; is_platform_admin: boolean; created_at: string; workspace_members: { count: number }[] }[];

  return (
    <>
      <PageHeader title="Users" description={`${rows.length} most recent (max 200).`} />
      <Card className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-fg-subtle">
            <tr>{["User", "Workspaces", "Role", "Joined"].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3"><p className="text-fg">{u.full_name || "—"}</p><p className="text-xs text-fg-subtle">{u.email}</p></td>
                <td className="px-4 py-3 tabular-nums text-fg">{u.workspace_members[0]?.count ?? 0}</td>
                <td className="px-4 py-3">{u.is_platform_admin ? <Badge tone="danger">Platform admin</Badge> : <Badge>User</Badge>}</td>
                <td className="whitespace-nowrap px-4 py-3 text-fg-subtle">{formatDate(u.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
