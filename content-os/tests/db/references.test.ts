import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addMember,
  asUser,
  createReference,
  createUser,
  createWorkspace,
  pool,
  sql,
  uploadVideo,
  upgradePlan,
  type TestUser,
} from "./helpers";

let owner: TestUser;
let member: TestUser;
let outsider: TestUser;
let ws: { id: string };
let wsOther: { id: string };

beforeAll(async () => {
  owner = await createUser();
  member = await createUser();
  outsider = await createUser();
  ws = await createWorkspace(owner, "Discover WS");
  await upgradePlan(ws.id);
  await addMember(ws.id, owner, member, "member");
  wsOther = await createWorkspace(outsider, "Other WS");
});

afterAll(() => pool.end());

describe("reference creation", () => {
  it("any member can create a reference in their workspace", async () => {
    const ref = await createReference(member, ws.id, {
      source_type: "instagram",
      url: "https://www.instagram.com/reel/ABC123/",
      normalized_url: "instagram:reel:ABC123",
      title: "A reel",
      category: "Education",
    });
    const { rows } = await sql("select analysis_status, media_status, created_by from public.content_references where id = $1", [ref.id]);
    expect(rows[0]).toEqual({ analysis_status: "not_analyzed", media_status: "none", created_by: member.id });
  });

  it("cannot create a reference in another workspace or on behalf of someone else", async () => {
    await expect(createReference(outsider, ws.id)).rejects.toMatchObject({ code: "42501" });
    await expect(createReference(member, ws.id, { created_by: owner.id })).rejects.toMatchObject({ code: "42501" });
  });

  it("clients cannot set server-managed columns", async () => {
    await expect(createReference(member, ws.id, { analysis_status: "analyzed" })).rejects.toMatchObject({ code: "42501" });
    await expect(createReference(member, ws.id, { media_path: `${ws.id}/x.mp4` })).rejects.toMatchObject({ code: "42501" });
    const ref = await createReference(member, ws.id);
    await expect(
      asUser(member, (q) => q("update public.content_references set media_status = 'uploaded' where id = $1", [ref.id])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("validates fields at the database level", async () => {
    await expect(createReference(member, ws.id, { title: "  " })).rejects.toMatchObject({ code: "23514" });
    await expect(createReference(member, ws.id, { url: "http://insecure.example" })).rejects.toMatchObject({ code: "23514" });
  });
});

describe("duplicate detection", () => {
  it("rejects the same normalized URL twice in a workspace, but allows it in another", async () => {
    const n = `instagram:reel:DUP${Date.now()}`;
    await createReference(member, ws.id, { normalized_url: n });
    await expect(createReference(owner, ws.id, { normalized_url: n })).rejects.toMatchObject({ code: "23505" });
    await expect(createReference(outsider, wsOther.id, { normalized_url: n })).resolves.toBeTruthy();
  });

  it("rejects the same provider item twice", async () => {
    await createReference(member, ws.id, { provider: "youtube", source_type: "youtube", external_id: "yt-1" });
    await expect(createReference(member, ws.id, { provider: "youtube", source_type: "youtube", external_id: "yt-1" })).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects the same uploaded file (sha256) twice", async () => {
    const sha = "a".repeat(64);
    const r1 = await createReference(member, ws.id);
    const r2 = await createReference(member, ws.id);
    await uploadVideo(member, r1.id, { sha });
    await expect(uploadVideo(member, r2.id, { sha })).rejects.toMatchObject({ code: "23505" });
  });
});

describe("organizing references", () => {
  it("members can tag, edit notes and delete references", async () => {
    const ref = await createReference(member, ws.id);
    await asUser(member, (q) => q("insert into public.reference_tags (reference_id, workspace_id, tag) values ($1, $2, 'hooks')", [ref.id, ws.id]));
    await asUser(owner, (q) => q("update public.content_references set notes = 'Great pacing', category = 'Fitness' where id = $1", [ref.id]));
    const { rows } = await asUser(member, (q) =>
      q("select r.notes, r.category, array_agg(t.tag) as tags from public.content_references r join public.reference_tags t on t.reference_id = r.id where r.id = $1 group by r.id", [ref.id]),
    );
    expect(rows[0]).toEqual({ notes: "Great pacing", category: "Fitness", tags: ["hooks"] });
    const del = await asUser(member, (q) => q("delete from public.content_references where id = $1", [ref.id]));
    expect(del.rowCount).toBe(1);
  });

  it("rejects malformed tags and tags pointing at another workspace's reference", async () => {
    const ref = await createReference(member, ws.id);
    await expect(
      asUser(member, (q) => q("insert into public.reference_tags (reference_id, workspace_id, tag) values ($1, $2, 'Bad Tag!')", [ref.id, ws.id])),
    ).rejects.toMatchObject({ code: "23514" });
    const foreign = await createReference(outsider, wsOther.id);
    await expect(
      asUser(member, (q) => q("insert into public.reference_tags (reference_id, workspace_id, tag) values ($1, $2, 'steal')", [foreign.id, ws.id])),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("workspace isolation (Discover)", () => {
  it("outsiders see nothing and cannot modify or delete", async () => {
    const ref = await createReference(member, ws.id, { title: "Private research" });
    const sel = await asUser(outsider, (q) => q("select id from public.content_references where id = $1", [ref.id]));
    expect(sel.rows).toHaveLength(0);
    const upd = await asUser(outsider, (q) => q("update public.content_references set notes = 'x' where id = $1", [ref.id]));
    const del = await asUser(outsider, (q) => q("delete from public.content_references where id = $1", [ref.id]));
    expect([upd.rowCount, del.rowCount]).toEqual([0, 0]);
  });

  it("searches and results are private to the workspace", async () => {
    const { rows } = await asUser(member, (q) =>
      q("insert into public.discovery_searches (workspace_id, query, providers, created_by) values ($1, 'hooks', '{library}', $2) returning id", [ws.id, member.id]),
    );
    const searchId = rows[0].id;
    await asUser(member, (q) =>
      q("insert into public.discovery_results (search_id, workspace_id, provider, external_id, title) values ($1, $2, 'library', 'r1', 'Result')", [searchId, ws.id]),
    );
    const s = await asUser(outsider, (q) => q("select * from public.discovery_searches where id = $1", [searchId]));
    const r = await asUser(outsider, (q) => q("select * from public.discovery_results where search_id = $1", [searchId]));
    expect([s.rows.length, r.rows.length]).toEqual([0, 0]);
    await expect(
      asUser(outsider, (q) =>
        q("insert into public.discovery_results (search_id, workspace_id, provider, external_id, title) values ($1, $2, 'library', 'x', 'Injected')", [searchId, wsOther.id]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("only the creator or an admin can delete a saved search", async () => {
    const { rows } = await asUser(owner, (q) =>
      q("insert into public.discovery_searches (workspace_id, query, is_saved, name, created_by) values ($1, 'q', true, 'Mine', $2) returning id", [ws.id, owner.id]),
    );
    const byMember = await asUser(member, (q) => q("delete from public.discovery_searches where id = $1", [rows[0].id]));
    expect(byMember.rowCount).toBe(0);
    const byOwner = await asUser(owner, (q) => q("delete from public.discovery_searches where id = $1", [rows[0].id]));
    expect(byOwner.rowCount).toBe(1);
  });
});

describe("upload flow and storage policies", () => {
  it("reserves a workspace-scoped path and only allows uploading to that exact path", async () => {
    const ref = await createReference(member, ws.id);
    const { rows } = await asUser(member, (q) => q("select public.begin_reference_upload($1, 'video/mp4', 2048) as path", [ref.id]));
    const path: string = rows[0].path;
    expect(path.startsWith(`${ws.id}/references/${ref.id}/`)).toBe(true);
    await expect(
      asUser(member, (q) =>
        q("insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{\"size\":1}')", [`${ws.id}/references/${ref.id}/other.mp4`]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      asUser(outsider, (q) => q("insert into storage.objects (bucket_id, name, metadata) values ('media', $1, '{\"size\":1}')", [path])),
    ).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects unsupported types, oversize files and outsiders", async () => {
    const ref = await createReference(member, ws.id);
    await expect(asUser(member, (q) => q("select public.begin_reference_upload($1, 'application/x-msdownload', 10)", [ref.id]))).rejects.toThrow(/unsupported/);
    await expect(asUser(member, (q) => q("select public.begin_reference_upload($1, 'video/mp4', 300000000)", [ref.id]))).rejects.toThrow(/200 MB/);
    await expect(asUser(outsider, (q) => q("select public.begin_reference_upload($1, 'video/mp4', 10)", [ref.id]))).rejects.toMatchObject({ code: "P0002" });
  });

  it("completing requires the object to exist and records its real size", async () => {
    const ref = await createReference(member, ws.id);
    await asUser(member, (q) => q("select public.begin_reference_upload($1, 'video/mp4', 999)", [ref.id]));
    await expect(asUser(member, (q) => q("select public.complete_reference_upload($1)", [ref.id]))).rejects.toThrow(/not found/);
    const ref2 = await createReference(member, ws.id);
    await uploadVideo(member, ref2.id, { size: 4096 });
    const { rows } = await sql("select media_status, media_size_bytes from public.content_references where id = $1", [ref2.id]);
    expect(rows[0]).toEqual({ media_status: "uploaded", media_size_bytes: "4096" });
  });

  it("members can read their workspace's media objects; outsiders cannot", async () => {
    const ref = await createReference(member, ws.id);
    const path = await uploadVideo(member, ref.id);
    const mine = await asUser(owner, (q) => q("select name from storage.objects where name = $1", [path]));
    const theirs = await asUser(outsider, (q) => q("select name from storage.objects where name = $1", [path]));
    expect([mine.rows.length, theirs.rows.length]).toEqual([1, 0]);
  });

  it("media of a live reference cannot be deleted; orphaned media can", async () => {
    const ref = await createReference(member, ws.id);
    const path = await uploadVideo(member, ref.id);
    const live = await asUser(member, (q) => q("delete from storage.objects where name = $1", [path]));
    expect(live.rowCount).toBe(0);
    await asUser(member, (q) => q("delete from public.content_references where id = $1", [ref.id]));
    const orphan = await asUser(member, (q) => q("delete from storage.objects where name = $1", [path]));
    expect(orphan.rowCount).toBe(1);
  });
});
