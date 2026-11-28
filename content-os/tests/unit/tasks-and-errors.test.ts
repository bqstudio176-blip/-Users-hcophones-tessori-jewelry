import { describe, expect, it } from "vitest";
import { dbErrorMessage } from "@/lib/db-errors";
import { derivePendingTasks, type TaskInput } from "@/lib/tasks";

const base: TaskInput = {
  canManage: true, socialStatus: null, hasNiche: false, hasBrandVoice: false,
  memberCount: 1, seatLimit: 2, pendingInvitations: 0, creditBalance: 50, profileHasName: true,
};

describe("derivePendingTasks", () => {
  it("derives tasks from real state", () => {
    const tasks = derivePendingTasks(base);
    expect(tasks.map((t) => [t.id, t.done])).toEqual([
      ["profile", true], ["instagram", false], ["niche", false], ["voice", false], ["team", false],
    ]);
  });
  it("marks connected Instagram as done and flags broken connections", () => {
    expect(derivePendingTasks({ ...base, socialStatus: "connected" }).find((t) => t.id === "instagram")?.done).toBe(true);
    expect(derivePendingTasks({ ...base, socialStatus: "expired" }).find((t) => t.id === "instagram")?.title).toBe("Reconnect Instagram");
  });
  it("hides manager-only tasks from members", () => {
    const ids = derivePendingTasks({ ...base, canManage: false }).map((t) => t.id);
    expect(ids).toEqual(["profile"]);
  });
  it("omits the invite task on single-seat plans", () => {
    expect(derivePendingTasks({ ...base, seatLimit: 1 }).some((t) => t.id === "team")).toBe(false);
  });
});

describe("dbErrorMessage", () => {
  it("maps known database errors to safe messages", () => {
    expect(dbErrorMessage({ code: "42501", message: "not authorized" })).toBe("You do not have permission to do that.");
    expect(dbErrorMessage({ code: "23505", message: 'duplicate key value violates unique constraint "workspaces_slug_key"' })).toBe("That workspace URL is already taken.");
    expect(dbErrorMessage({ code: "54000", message: "member limit reached for current plan" })).toMatch(/member limit/);
    expect(dbErrorMessage({ code: "XX000", message: "internal detail: password=hunter2" })).toBe("Something went wrong. Please try again.");
  });
});
