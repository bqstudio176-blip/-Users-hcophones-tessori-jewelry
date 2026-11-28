import type { Metadata } from "next";
import { InviteMemberForm } from "@/components/app/settings-forms";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/states";
import { can, canChangeRole, canRemoveMember, invitableRoles, ROLE_LABELS, type WorkspaceRole } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDate } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { changeMemberRole, removeMember, revokeInvitation } from "@/server/actions/workspace";

export const metadata: Metadata = { title: "Members" };

interface MemberRow {
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  profile: { full_name: string | null; email: string } | null;
}

export default async function MembersPage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const wsId = ctx.workspace.id;
  const canInvite = can(ctx.role, "members.invite");

  const [membersRes, invitesRes, seatsRes, limitRes] = await Promise.all([
    supabase
      .from("workspace_members")
      .select("user_id, role, created_at, profile:profiles!workspace_members_user_id_fkey(full_name, email)")
      .eq("workspace_id", wsId)
      .order("created_at"),
    canInvite
      ? supabase
          .from("workspace_invitations")
          .select("id, email, role, expires_at, created_at")
          .eq("workspace_id", wsId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
    supabase.rpc("workspace_seat_usage", { p_workspace_id: wsId }),
    supabase.rpc("workspace_seat_limit", { p_workspace_id: wsId }),
  ]);
  if (membersRes.error) throw new Error(`Could not load members: ${membersRes.error.message}`);

  const members = (membersRes.data ?? []) as unknown as MemberRow[];
  const invites = (invitesRes.data ?? []) as { id: string; email: string; role: WorkspaceRole; expires_at: string }[];
  const seatsUsed = Number(seatsRes.data ?? members.length);
  const seatLimit = Number(limitRes.data ?? 1);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Members</CardTitle>
          <CardDescription>{seatsUsed} of {seatLimit} seats used (including pending invitations).</CardDescription>
        </CardHeader>
        <ul className="divide-y divide-line">
          {members.map((m) => {
            const isSelf = m.user_id === ctx.user.id;
            const removable = canRemoveMember({ id: ctx.user.id, role: ctx.role }, { id: m.user_id, role: m.role });
            const roleEditable = canChangeRole(ctx.role, m, "member");
            const name = m.profile?.full_name || m.profile?.email || "Unknown user";
            return (
              <li key={m.user_id} className="flex flex-col gap-3 px-5 py-3 sm:flex-row sm:items-center">
                <div className="flex min-w-0 flex-1 items-center gap-3">
                  <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-fg">{name.slice(0, 1).toUpperCase()}</span>
                  <div className="min-w-0">
                    <p className="truncate text-sm text-fg">{name}{isSelf && <span className="text-fg-subtle"> (you)</span>}</p>
                    <p className="truncate text-xs text-fg-subtle">{m.profile?.email} · joined {formatDate(m.created_at)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {roleEditable ? (
                    <form action={changeMemberRole} className="flex items-center gap-2">
                      <input type="hidden" name="userId" value={m.user_id} />
                      <label htmlFor={`role-${m.user_id}`} className="sr-only">Role for {name}</label>
                      <Select id={`role-${m.user_id}`} name="role" defaultValue={m.role} className="h-8 w-28 text-xs">
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </Select>
                      <Button type="submit" variant="outline" size="sm">Update</Button>
                    </form>
                  ) : (
                    <Badge tone={m.role === "owner" ? "accent" : m.role === "admin" ? "info" : "neutral"}>{ROLE_LABELS[m.role]}</Badge>
                  )}
                  {removable && (
                    <form action={removeMember}>
                      <input type="hidden" name="userId" value={m.user_id} />
                      <Button type="submit" variant="ghost" size="sm" className="text-danger hover:text-danger">
                        {isSelf ? "Leave" : "Remove"}
                      </Button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {canInvite && (
        <Card>
          <CardHeader>
            <CardTitle>Invite people</CardTitle>
            <CardDescription>Invitations are single-use, tied to the email address and expire after 7 days.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {seatsUsed >= seatLimit ? (
              <EmptyState title="All seats are in use" description="Remove a member or revoke an invitation to invite someone new. Plan upgrades arrive with billing." />
            ) : (
              <InviteMemberForm roles={invitableRoles(ctx.role)} />
            )}
            <div>
              <h3 className="mb-2 text-xs font-medium text-fg-muted">Pending invitations</h3>
              {invites.length === 0 ? (
                <p className="text-xs text-fg-subtle">No pending invitations.</p>
              ) : (
                <ul className="divide-y divide-line rounded-md border border-line">
                  {invites.map((inv) => (
                    <li key={inv.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                      <span className="min-w-0 flex-1 truncate text-fg">{inv.email}</span>
                      <Badge>{ROLE_LABELS[inv.role]}</Badge>
                      <span className="hidden text-xs text-fg-subtle sm:inline">expires {formatDate(inv.expires_at)}</span>
                      <form action={revokeInvitation}>
                        <input type="hidden" name="invitationId" value={inv.id} />
                        <Button type="submit" variant="ghost" size="sm">Revoke</Button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
