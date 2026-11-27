import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addMember, asUser, createReference, createUser, createWorkspace, creditBalance, makePlatformAdmin, pool, sql, upgradePlan, type TestUser } from "./helpers";

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: { id: string };
let wsOther: { id: string };

async function project(user: TestUser, wsId: string, name = "Project") {
  const { rows } = await asUser(user, (q) => q("insert into public.creative_projects (workspace_id, name, created_by) values ($1, $2, $3) returning id", [wsId, name, user.id]));
  return rows[0].id as string;
}
async function strategy(user: TestUser, wsId: string, projectId: string, extra: Record<string, unknown> = {}) {
  const row = { workspace_id: wsId, project_id: projectId, name: "Strategy", objective: "educate", created_by: user.id, ...extra };
  const cols = Object.keys(row);
  const { rows } = await asUser(user, (q) => q(`insert into public.content_strategies (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning id`, Object.values(row)));
  return rows[0].id as string;
}
async function script(user: TestUser, wsId: string, projectId: string) {
  const { rows } = await asUser(user, (q) => q("insert into public.scripts (workspace_id, project_id, title, format, target_duration_seconds, created_by) values ($1, $2, 'S', 'instagram_reel', 30, $3) returning id", [wsId, projectId, user.id]));
  return rows[0].id as string;
}
const scenesJson = (n: number, locked = -1) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ section: i === 0 ? "hook" : "main_development", scene_title: `Scene ${i + 1}`, estimated_duration_seconds: 5, spoken_text: `Line ${i + 1}`, is_locked: i === locked })));

beforeAll(async () => {
  owner = await createUser();
  member = await createUser();
  outsider = await createUser();
  ws = await createWorkspace(owner, "Creative WS");
  await upgradePlan(ws.id);
  await sql("select public.apply_credit_transaction($1, 'grant', 500, 'test top-up')", [ws.id]);
  await addMember(ws.id, owner, member, "member");
  wsOther = await createWorkspace(outsider, "Other Creative WS");
});

afterAll(() => pool.end());

describe("projects and strategies", () => {
  it("members create projects and strategies; outsiders cannot see or write them", async () => {
    const p = await project(member, ws.id);
    const s = await strategy(member, ws.id, p, { target_audience: "Busy parents", duration_seconds: 45 });
    const seen = await asUser(outsider, (q) => q("select id from public.content_strategies where id = $1", [s]));
    expect(seen.rows).toHaveLength(0);
    await expect(strategy(outsider, ws.id, p)).rejects.toMatchObject({ code: "42501" });
    const upd = await asUser(outsider, (q) => q("update public.creative_projects set name = 'x' where id = $1", [p]));
    expect(upd.rowCount).toBe(0);
  });

  it("rejects strategies that reference another workspace's content or project", async () => {
    const foreignRef = await createReference(outsider, wsOther.id);
    const p = await project(member, ws.id);
    await expect(strategy(member, ws.id, p, { reference_ids: `{${foreignRef.id}}` })).rejects.toMatchObject({ code: "23514" });
    const foreignProject = await project(outsider, wsOther.id);
    await expect(strategy(member, ws.id, foreignProject)).rejects.toMatchObject({ code: "23514" });
  });

  it("validates strategy fields", async () => {
    const p = await project(member, ws.id);
    await expect(strategy(member, ws.id, p, { objective: "go_viral" })).rejects.toMatchObject({ code: "23514" });
    await expect(strategy(member, ws.id, p, { duration_seconds: 2 })).rejects.toMatchObject({ code: "23514" });
  });
});

describe("creative rules", () => {
  it("the global library is visible to every signed-in user and immutable for non-admins", async () => {
    const { rows } = await asUser(outsider, (q) => q("select count(*)::int as n from public.creative_rules where workspace_id is null"));
    expect(rows[0].n).toBe(110);
    const upd = await asUser(owner, (q) => q("update public.creative_rules set name = 'hacked' where workspace_id is null"));
    expect(upd.rowCount).toBe(0);
    await expect(asUser(owner, (q) => q("insert into public.creative_rules (workspace_id, slug, name, category, description, objective, application_conditions, example, evidence_type, status, created_by) values (null, 'global-x', 'Global X', 'curiosity', 'A description here', 'Objective', '{a}', 'Example text', 'experimental', 'approved', $1)", [owner.id]))).rejects.toMatchObject({ code: "42501" });
  });

  it("workspace rules: members draft, owners approve; edits are versioned and need re-approval", async () => {
    const { rows } = await asUser(member, (q) => q("insert into public.creative_rules (workspace_id, slug, name, category, description, objective, application_conditions, example, evidence_type, status, created_by) values ($1, 'our-hook-rule', 'Our hook rule', 'hooks_openings', 'Always show the product in the first frame.', 'Make product visible', '{\"Product videos\"}', 'Open on the bottle.', 'practitioner_heuristic', 'draft', $2) returning id", [ws.id, member.id]));
    const id = rows[0].id;
    await expect(asUser(member, (q) => q("insert into public.creative_rules (workspace_id, slug, name, category, description, objective, application_conditions, example, evidence_type, status, created_by) values ($1, 'sneaky', 'Sneaky', 'curiosity', 'Approved by myself here', 'x obj', '{a}', 'Example x', 'experimental', 'approved', $2)", [ws.id, member.id]))).rejects.toMatchObject({ code: "42501" });
    await expect(asUser(member, (q) => q("update public.creative_rules set status = 'approved' where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(member, (q) => q("select public.set_creative_rule_status($1, 'pending_approval')", [id]));
    await expect(asUser(member, (q) => q("select public.set_creative_rule_status($1, 'approved')", [id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(owner, (q) => q("select public.set_creative_rule_status($1, 'approved')", [id]));
    await asUser(member, (q) => q("update public.creative_rules set description = 'Show the product within the first second.' where id = $1", [id]));
    const after = await sql("select version, status from public.creative_rules where id = $1", [id]);
    expect(after.rows[0]).toEqual({ version: 2, status: "pending_approval" });
    const versions = await asUser(member, (q) => q("select version, snapshot->>'description' as d from public.creative_rule_versions where rule_id = $1", [id]));
    expect(versions.rows).toEqual([{ version: 1, d: "Always show the product in the first frame." }]);
    const hidden = await asUser(outsider, (q) => q("select id from public.creative_rules where id = $1", [id]));
    expect(hidden.rows).toHaveLength(0);
  });

  it("owners can disable a global rule for their workspace only; platform admins govern global rules", async () => {
    const { rows } = await sql("select id from public.creative_rules where slug = 'rule-of-three'");
    await expect(asUser(member, (q) => q("select public.set_creative_rule_override($1, $2, false)", [ws.id, rows[0].id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(owner, (q) => q("select public.set_creative_rule_override($1, $2, false)", [ws.id, rows[0].id]));
    const o = await asUser(outsider, (q) => q("select * from public.creative_rule_overrides where rule_id = $1", [rows[0].id]));
    expect(o.rows).toHaveLength(0);
    await expect(asUser(owner, (q) => q("select public.set_creative_rule_status($1, 'disabled')", [rows[0].id]))).rejects.toMatchObject({ code: "42501" });
    const staff = await createUser();
    await makePlatformAdmin(staff);
    await asUser(staff, (q) => q("select public.set_creative_rule_status($1, 'approved')", [rows[0].id]));
  });

  it("history is append-only", async () => {
    await expect(asUser(owner, (q) => q("delete from public.creative_rule_versions"))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("AI usage accounting", () => {
  const record = (user: TestUser, wsId: string, status: string, agent = "hook") =>
    asUser(user, (q) => q("select public.record_ai_agent_run($1, null, $2::public.creative_agent, $3, 'mock', 'mock-claude', 'hook@1', 100, 50, 10, 0.01, null, '{}', $4) as r", [wsId, agent, status, JSON.stringify([{ purpose: agent, status: status === "succeeded" ? "succeeded" : "failed", input_tokens: 100, output_tokens: 50 }])])).then((r) => r.rows[0].r);

  it("charges agent credits only on success and links usage records", async () => {
    const before = await creditBalance(ws.id);
    const ok = await record(owner, ws.id, "succeeded", "script");
    expect(ok.credits_charged).toBe(4);
    expect(await creditBalance(ws.id)).toBe(before - 4);
    const failed = await record(owner, ws.id, "failed", "script");
    expect(failed.credits_charged).toBe(0);
    expect(await creditBalance(ws.id)).toBe(before - 4);
    const inv = await sql("select count(*)::int as n from public.ai_invocations where agent_run_id = $1", [ok.run_id]);
    expect(inv.rows[0].n).toBe(1);
    const ledger = await sql("select reason, amount from public.usage_transactions where idempotency_key = $1", [`agent-run:${ok.run_id}`]);
    expect(ledger.rows[0]).toEqual({ reason: "AI script agent", amount: -4 });
  });

  it("check_ai_usage reports credits and enforces the per-user rate limit", async () => {
    const u = await createUser();
    const w = await createWorkspace(u, "Rate WS"); // free plan: 5 runs/user/min
    for (let i = 0; i < 5; i++) await record(u, w.id, "failed");
    const { rows } = await asUser(u, (q) => q("select public.check_ai_usage($1, 'hook') as r", [w.id]));
    expect(rows[0].r).toMatchObject({ allowed: false, reason: "rate_limited", credits_required: 2 });
  });

  it("blocks generation without enough credits and never records a free success", async () => {
    const u = await createUser();
    const w = await createWorkspace(u, "Broke WS");
    await sql("select public.apply_credit_transaction($1, 'consume', -49, 'drain')", [w.id]);
    const { rows } = await asUser(u, (q) => q("select public.check_ai_usage($1, 'script') as r", [w.id]));
    expect(rows[0].r).toMatchObject({ allowed: false, reason: "insufficient_credits" });
    await expect(record(u, w.id, "succeeded", "script")).rejects.toThrow(/insufficient credits/);
    const runs = await sql("select count(*)::int as n from public.ai_agent_runs where workspace_id = $1 and status = 'succeeded'", [w.id]);
    expect(runs.rows[0].n).toBe(0);
  });

  it("outsiders cannot record runs or read usage", async () => {
    await expect(record(outsider, ws.id, "succeeded")).rejects.toMatchObject({ code: "42501" });
    const { rows } = await asUser(outsider, (q) => q("select count(*)::int as n from public.ai_agent_runs where workspace_id = $1", [ws.id]));
    expect(rows[0].n).toBe(0);
    await expect(asUser(owner, (q) => q("insert into public.ai_agent_runs (workspace_id, agent, status) values ($1, 'hook', 'succeeded')", [ws.id]))).rejects.toMatchObject({ code: "42501" });
  });
});

describe("scripts, scenes and versions", () => {
  it("creates versioned content, reorders, inserts and deletes scenes", async () => {
    const p = await project(member, ws.id);
    const s = await script(member, ws.id, p);
    const v1 = await asUser(member, (q) => q("select public.replace_script_content($1, 'Title', '{}', $2, 'generated') as v", [s, scenesJson(3)]));
    expect(v1.rows[0].v).toBe(1);
    const ids = (await sql("select id from public.script_scenes where script_id = $1 order by position", [s])).rows.map((r) => r.id);
    await asUser(member, (q) => q("select public.reorder_script_scenes($1, $2)", [s, [ids[2], ids[0], ids[1]]]));
    const order = (await sql("select scene_title from public.script_scenes where script_id = $1 order by position", [s])).rows.map((r) => r.scene_title);
    expect(order).toEqual(["Scene 3", "Scene 1", "Scene 2"]);
    await expect(asUser(member, (q) => q("select public.reorder_script_scenes($1, $2)", [s, [ids[0], ids[1]]]))).rejects.toMatchObject({ code: "22023" });
    await asUser(member, (q) => q("select public.insert_script_scene($1, 2, '{\"scene_title\":\"Inserted\"}')", [s]));
    const titles = (await sql("select scene_title, position from public.script_scenes where script_id = $1 order by position", [s])).rows;
    expect(titles.map((t) => t.scene_title)).toEqual(["Scene 3", "Inserted", "Scene 1", "Scene 2"]);
    await asUser(member, (q) => q("select public.delete_script_scene($1)", [ids[0]]));
    const positions = (await sql("select position from public.script_scenes where script_id = $1 order by position", [s])).rows.map((r) => r.position);
    expect(positions).toEqual([1, 2, 3]);
  });

  it("saves and restores versions reversibly", async () => {
    const p = await project(member, ws.id);
    const s = await script(member, ws.id, p);
    await asUser(member, (q) => q("select public.replace_script_content($1, 'T', '{}', $2, 'generated')", [s, scenesJson(2)]));
    await asUser(member, (q) => q("update public.script_scenes set spoken_text = 'Edited by me' where script_id = $1 and position = 1", [s]));
    const v2 = await asUser(member, (q) => q("select public.save_script_version($1, 'my edit') as v", [s]));
    expect(v2.rows[0].v).toBe(2);
    await asUser(member, (q) => q("select public.restore_script_version($1, 1)", [s]));
    const versions = (await sql("select version, source from public.script_versions where script_id = $1 order by version", [s])).rows;
    expect(versions).toEqual([{ version: 1, source: "generated" }, { version: 2, source: "manual_save" }, { version: 3, source: "before_restore" }, { version: 4, source: "restored" }]);
    const first = await sql("select spoken_text from public.script_scenes where script_id = $1 and position = 1", [s]);
    expect(first.rows[0].spoken_text).toBe("Line 1");
    await expect(asUser(member, (q) => q("update public.script_versions set note = 'x' where script_id = $1", [s]))).rejects.toMatchObject({ code: "42501" });
  });

  it("AI edits cannot change or drop locked scenes", async () => {
    const p = await project(member, ws.id);
    const s = await script(member, ws.id, p);
    await asUser(member, (q) => q("select public.replace_script_content($1, 'T', '{}', $2, 'generated')", [s, scenesJson(2, 0)]));
    const proposal = JSON.stringify([{ section: "hook", scene_title: "Scene 1", estimated_duration_seconds: 5, spoken_text: "AI changed this" }]);
    await expect(asUser(member, (q) => q("select public.replace_script_content($1, 'T', '{}', $2, 'ai_edit_applied')", [s, proposal]))).rejects.toMatchObject({ code: "42501" });
  });

  it("outsiders cannot touch scripts", async () => {
    const p = await project(member, ws.id);
    const s = await script(member, ws.id, p);
    await asUser(member, (q) => q("select public.replace_script_content($1, 'T', '{}', $2, 'generated')", [s, scenesJson(1)]));
    await expect(asUser(outsider, (q) => q("select public.save_script_version($1)", [s]))).rejects.toMatchObject({ code: "P0002" });
    await expect(asUser(outsider, (q) => q("select public.restore_script_version($1, 1)", [s]))).rejects.toMatchObject({ code: "P0002" });
    const upd = await asUser(outsider, (q) => q("update public.script_scenes set spoken_text = 'pwned' where script_id = $1", [s]));
    expect(upd.rowCount).toBe(0);
  });
});

describe("feedback and preferences", () => {
  it("stores feedback for workspace content only, with valid reasons", async () => {
    const p = await project(member, ws.id);
    const s = await script(member, ws.id, p);
    await asUser(member, (q) => q("insert into public.script_feedback (workspace_id, target_type, target_id, target_version, rating, reasons, created_by) values ($1, 'script', $2, 1, 'not_useful', '{too_long,wrong_tone}', $3)", [ws.id, s, member.id]));
    await expect(asUser(member, (q) => q("insert into public.script_feedback (workspace_id, target_type, target_id, rating, reasons, created_by) values ($1, 'script', $2, 'useful', '{amazing}', $3)", [ws.id, s, member.id]))).rejects.toMatchObject({ code: "23514" });
    const foreignP = await project(outsider, wsOther.id);
    const foreignS = await script(outsider, wsOther.id, foreignP);
    await expect(asUser(member, (q) => q("insert into public.script_feedback (workspace_id, target_type, target_id, rating, created_by) values ($1, 'script', $2, 'useful', $3)", [ws.id, foreignS, member.id]))).rejects.toMatchObject({ code: "23514" });
    const seen = await asUser(outsider, (q) => q("select * from public.script_feedback where workspace_id = $1", [ws.id]));
    expect(seen.rows).toHaveLength(0);
  });

  it("only owners/admins approve preferences", async () => {
    await expect(asUser(member, (q) => q("insert into public.creative_preferences (workspace_id, kind, scope, statement, approved, created_by) values ($1, 'avoid', 'length', 'Keep scripts under 40 seconds', true, $2)", [ws.id, member.id]))).rejects.toMatchObject({ code: "42501" });
    const { rows } = await asUser(member, (q) => q("insert into public.creative_preferences (workspace_id, kind, scope, statement, created_by) values ($1, 'avoid', 'length', 'Keep scripts under 40 seconds', $2) returning id", [ws.id, member.id]));
    await expect(asUser(member, (q) => q("select public.set_creative_preference_approval($1, true)", [rows[0].id]))).rejects.toMatchObject({ code: "42501" });
    await asUser(owner, (q) => q("select public.set_creative_preference_approval($1, true)", [rows[0].id]));
    const p = await sql("select approved from public.creative_preferences where id = $1", [rows[0].id]);
    expect(p.rows[0].approved).toBe(true);
  });
});
