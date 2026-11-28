import { describe, expect, it } from "vitest";
import { can, canChangeRole, canRemoveMember, invitableRoles, type WorkspaceAction } from "@/lib/auth/permissions";

const MANAGER_ONLY: WorkspaceAction[] = ["workspace.update", "settings.update", "members.invite", "members.remove", "invitations.view", "social.manage", "audit.view"];
const EVERYONE: WorkspaceAction[] = ["workspace.view", "members.view", "social.view", "billing.view"];

describe("role permission matrix", () => {
  it("grants read capabilities to every role", () => {
    for (const role of ["owner", "admin", "member"] as const) for (const a of EVERYONE) expect(can(role, a)).toBe(true);
  });
  it("restricts management capabilities to owner and admin", () => {
    for (const a of MANAGER_ONLY) {
      expect(can("owner", a)).toBe(true);
      expect(can("admin", a)).toBe(true);
      expect(can("member", a)).toBe(false);
    }
  });
  it("reserves role changes and admin invitations for the owner", () => {
    expect(can("owner", "members.change_role")).toBe(true);
    expect(can("admin", "members.change_role")).toBe(false);
    expect(can("owner", "members.invite_admin")).toBe(true);
    expect(can("admin", "members.invite_admin")).toBe(false);
  });
  it("denies everything without a role", () => {
    for (const a of [...EVERYONE, ...MANAGER_ONLY]) {
      expect(can(null, a)).toBe(false);
      expect(can(undefined, a)).toBe(false);
    }
  });
  it("lists invitable roles per actor", () => {
    expect(invitableRoles("owner")).toEqual(["admin", "member"]);
    expect(invitableRoles("admin")).toEqual(["member"]);
    expect(invitableRoles("member")).toEqual([]);
  });
});

describe("member removal rules (mirror remove_workspace_member)", () => {
  const owner = { id: "o", role: "owner" as const };
  const admin = { id: "a", role: "admin" as const };
  const admin2 = { id: "a2", role: "admin" as const };
  const member = { id: "m", role: "member" as const };
  const member2 = { id: "m2", role: "member" as const };

  it("nobody can remove the owner, not even themselves", () => {
    expect(canRemoveMember(owner, owner)).toBe(false);
    expect(canRemoveMember(admin, owner)).toBe(false);
  });
  it("owner removes anyone else", () => {
    expect(canRemoveMember(owner, admin)).toBe(true);
    expect(canRemoveMember(owner, member)).toBe(true);
  });
  it("admin removes members only", () => {
    expect(canRemoveMember(admin, member)).toBe(true);
    expect(canRemoveMember(admin, admin2)).toBe(false);
  });
  it("members can only leave", () => {
    expect(canRemoveMember(member, member2)).toBe(false);
    expect(canRemoveMember(member, member)).toBe(true);
    expect(canRemoveMember(admin, admin)).toBe(true);
  });
  it("only owner changes non-owner roles, never to owner", () => {
    expect(canChangeRole("owner", member, "admin")).toBe(true);
    expect(canChangeRole("owner", owner, "member")).toBe(false);
    expect(canChangeRole("owner", member, "owner")).toBe(false);
    expect(canChangeRole("admin", member, "admin")).toBe(false);
  });
});
