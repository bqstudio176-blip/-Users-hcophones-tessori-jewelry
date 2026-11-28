import { buildInitialTimeline, type Timeline } from "@/server/video/timeline";
import { asUser, sql, type TestUser } from "./helpers";

/** Creates a Script Lab script with scenes directly (setup only). */
export async function createScript(user: TestUser, workspaceId: string, opts: { target?: number; scenes?: { title: string; seconds: number; spoken: string; onScreen?: string }[] } = {}) {
  const { rows: p } = await sql("insert into public.creative_projects (workspace_id, name, created_by) values ($1, 'Video test project', $2) returning id", [workspaceId, user.id]);
  const { rows: s } = await sql(
    "insert into public.scripts (workspace_id, project_id, title, format, target_duration_seconds, current_version, created_by) values ($1, $2, 'Test script', 'instagram_reel', $3, 1, $4) returning id",
    [workspaceId, p[0].id, opts.target ?? 6, user.id],
  );
  const scenes = opts.scenes ?? [
    { title: "Hook", seconds: 2, spoken: "Stop scrolling for a second", onScreen: "Wait!" },
    { title: "Point", seconds: 2, spoken: "Here is the one idea that matters" },
    { title: "CTA", seconds: 2, spoken: "Follow for part two" },
  ];
  let pos = 1;
  for (const sc of scenes) {
    await sql(
      "insert into public.script_scenes (workspace_id, script_id, position, section, scene_title, estimated_duration_seconds, spoken_text, on_screen_text) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [workspaceId, s[0].id, pos, pos === 1 ? "hook" : "main_development", sc.title, sc.seconds, sc.spoken, sc.onScreen ?? ""],
    );
    pos++;
  }
  return s[0].id as string;
}

export async function scriptScenes(scriptId: string) {
  const { rows } = await sql("select id, position, scene_title, estimated_duration_seconds, spoken_text, on_screen_text from public.script_scenes where script_id = $1 order by position", [scriptId]);
  return rows;
}

/** Creates a video project through the real RPC, as the user. */
export async function createVideo(user: TestUser, scriptId: string, format: "vertical" | "square" | "portrait" = "vertical") {
  const timeline = buildInitialTimeline(await scriptScenes(scriptId), format);
  const { rows } = await asUser(user, (q) => q("select public.create_video_project($1, null, $2, $3) as id", [scriptId, format, JSON.stringify(timeline)]));
  return { id: rows[0].id as string, timeline };
}

/** Full upload flow as the user: reserve → storage object (RLS) → complete. Returns asset id + path. */
export async function uploadAsset(user: TestUser, workspaceId: string, kind: "video" | "image" | "audio", opts: { mime?: string; size?: number; title?: string } = {}) {
  const mime = opts.mime ?? { video: "video/mp4", image: "image/png", audio: "audio/mp4" }[kind];
  const size = opts.size ?? 2048;
  const { rows } = await asUser(user, (q) => q("select public.begin_media_upload($1, $2, $3, $4, $5, true) as r", [workspaceId, kind, mime, size, opts.title ?? `${kind} asset`]));
  const { asset_id, path } = rows[0].r as { asset_id: string; path: string };
  await asUser(user, (q) => q("insert into storage.objects (bucket_id, name, owner, metadata) values ('media', $1, $2, $3)", [path, user.id, JSON.stringify({ size, mimetype: mime })]));
  await asUser(user, (q) => q("select public.complete_media_upload($1) as job", [asset_id]));
  return { id: asset_id, path };
}

/** Marks an asset processed (skips the worker) for DB-only tests. */
export async function markReady(assetId: string, opts: { duration?: number; hasAudio?: boolean } = {}) {
  await sql("update public.video_jobs set status = 'succeeded' where asset_id = $1", [assetId]);
  await sql("update public.media_assets set status = 'ready', duration_seconds = $2, has_audio = $3 where id = $1", [assetId, opts.duration ?? 10, opts.hasAudio ?? true]);
}

export async function projectRow(id: string) {
  const { rows } = await sql("select * from public.video_projects where id = $1", [id]);
  return rows[0];
}

export function withVisual(t: Timeline, assetId: string, kind: "video" | "image" = "video"): Timeline {
  return { ...t, scenes: t.scenes.map((s) => ({ ...s, visual: { asset_id: assetId, kind, trim_start: 0, fit: "fill" as const, focal_x: 0.5, focal_y: 0.5, ken_burns: kind === "image", volume: 0 } })) };
}
