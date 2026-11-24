/**
 * Application-level mirror of the role model enforced in the database
 * (migration 0200/0300). Used to decide what to RENDER and as an early check
 * in server actions. The database remains the source of truth: every one of
 * these capabilities is re-checked by RLS or a SECURITY DEFINER RPC.
 */
export const WORKSPACE_ROLES = ["owner", "admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type WorkspaceAction =
  | "workspace.view"
  | "workspace.update"
  | "settings.update"
  | "members.view"
  | "members.invite"
  | "members.invite_admin"
  | "members.change_role"
  | "members.remove"
  | "invitations.view"
  | "social.view"
  | "social.manage"
  | "billing.view"
  | "audit.view";

const MATRIX: Record<WorkspaceAction, readonly WorkspaceRole[]> = {
  "workspace.view": ["owner", "admin", "member"],
  "workspace.update": ["owner", "admin"],
  "settings.update": ["owner", "admin"],
  "members.view": ["owner", "admin", "member"],
  "members.invite": ["owner", "admin"],
  "members.invite_admin": ["owner"],
  "members.change_role": ["owner"],
  "members.remove": ["owner", "admin"],
  "invitations.view": ["owner", "admin"],
  "social.view": ["owner", "admin", "member"],
  "social.manage": ["owner", "admin"],
  "billing.view": ["owner", "admin", "member"],
  "audit.view": ["owner", "admin"],
};

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function can(role: WorkspaceRole | null | undefined, action: WorkspaceAction): boolean {
  if (!role) return false;
  return MATRIX[action].includes(role);
}

/** Roles `actor` may assign when inviting. */
export function invitableRoles(actor: WorkspaceRole | null | undefined): Exclude<WorkspaceRole, "owner">[] {
  if (actor === "owner") return ["admin", "member"];
  if (actor === "admin") return ["member"];
  return [];
}

/**
 * Whether `actor` (acting as `actorId`) may remove `target` (`targetId`).
 * Mirrors public.remove_workspace_member().
 */
export function canRemoveMember(
  actor: { id: string; role: WorkspaceRole | null | undefined },
  target: { id: string; role: WorkspaceRole },
): boolean {
  if (!actor.role) return false;
  if (target.role === "owner") return false;
  if (actor.id === target.id) return true; // leaving
  if (actor.role === "owner") return true;
  if (actor.role === "admin") return target.role === "member";
  return false;
}

export function canChangeRole(
  actorRole: WorkspaceRole | null | undefined,
  target: { role: WorkspaceRole },
  nextRole: WorkspaceRole,
): boolean {
  return actorRole === "owner" && target.role !== "owner" && nextRole !== "owner";
}

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};
