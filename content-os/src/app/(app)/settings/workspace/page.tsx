import type { Metadata } from "next";
import { WorkspaceSettingsForm } from "@/components/app/settings-forms";
import { Alert } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { can } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { auditLabel, formatDateTime } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import type { AuditLog, WorkspaceSettings } from "@/lib/types";

export const metadata: Metadata = { title: "Workspace settings" };

function timezones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export default async function WorkspaceSettingsPage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const canEdit = can(ctx.role, "settings.update");
  const canAudit = can(ctx.role, "audit.view");

  const [{ data: settings, error }, audit] = await Promise.all([
    supabase.from("workspace_settings").select("*").eq("workspace_id", ctx.workspace.id).single(),
    canAudit
      ? supabase.from("audit_logs").select("*").eq("workspace_id", ctx.workspace.id).order("created_at", { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as AuditLog[], error: null }),
  ]);
  if (error || !settings) throw new Error("Could not load workspace settings");
  if (audit.error) throw new Error("Could not load activity");

  const actorIds = [...new Set((audit.data ?? []).map((a) => a.actor_id).filter(Boolean))] as string[];
  const { data: actors } = actorIds.length
    ? await supabase.from("profiles").select("id, full_name, email").in("id", actorIds)
    : { data: [] as { id: string; full_name: string | null; email: string }[] };
  const actorName = new Map((actors ?? []).map((p) => [p.id, p.full_name || p.email]));

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Workspace</CardTitle>
          <CardDescription>General configuration used across every module.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!canEdit && <Alert tone="info">Only owners and admins can change workspace settings.</Alert>}
          <WorkspaceSettingsForm name={ctx.workspace.name} settings={settings as WorkspaceSettings} timezones={timezones()} canEdit={canEdit} />
          <p className="text-xs text-fg-subtle">Workspace URL: <code className="kbd">{ctx.workspace.slug}</code> (cannot be changed)</p>
        </CardContent>
      </Card>

      <Card id="activity">
        <CardHeader>
          <CardTitle>Activity log</CardTitle>
          <CardDescription>The 50 most recent audited events in this workspace.</CardDescription>
        </CardHeader>
        <CardContent>
          {!canAudit ? (
            <EmptyState title="Visible to admins" description="Only owners and admins can view the activity log." />
          ) : (audit.data ?? []).length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="text-fg-subtle">
                  <tr><th scope="col" className="pb-2 font-medium">Event</th><th scope="col" className="pb-2 font-medium">By</th><th scope="col" className="pb-2 text-right font-medium">When</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {(audit.data as AuditLog[]).map((a) => (
                    <tr key={a.id}>
                      <td className="py-2 pr-4 text-fg">{auditLabel(a.action)}</td>
                      <td className="py-2 pr-4 text-fg-muted">{a.actor_id ? actorName.get(a.actor_id) ?? "Former member" : "System"}</td>
                      <td className="whitespace-nowrap py-2 text-right text-fg-subtle">{formatDateTime(a.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
