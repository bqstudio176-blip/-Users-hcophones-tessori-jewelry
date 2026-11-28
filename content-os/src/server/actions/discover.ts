"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getWorkspaceContext } from "@/lib/auth/session";
import { dbErrorMessage } from "@/lib/db-errors";
import { CONTENT_FORMATS, normalizeTags, REFERENCE_CATEGORIES } from "@/lib/discover/catalog";
import { validateUploadMeta } from "@/lib/discover/upload";
import { parseReferenceUrl } from "@/lib/discover/url";
import { createClient } from "@/lib/supabase/server";
import type { ActionState } from "@/lib/types";
import { fieldErrors, uuidSchema } from "@/lib/validation";
import { getWorkspaceInstagramToken } from "@/server/discovery/instagram-token";
import { applyLibraryFilters, discoveryToLibraryParams, librarySelect, libraryRowToResult, type LibraryRow } from "@/server/discovery/library";
import { DISCOVERY_PROVIDERS, runDiscovery } from "@/server/discovery/registry";
import type { DiscoveryQuery } from "@/server/discovery/types";
import { checkReferenceUrl } from "@/server/discovery/url-check";

const optional = (max: number) => z.string().trim().max(max).transform((v) => (v === "" ? null : v));

const metadataSchema = z.object({
  title: z.string().trim().max(200),
  description: optional(5000),
  category: z.union([z.enum(REFERENCE_CATEGORIES), z.literal("")]).transform((v) => (v === "" ? null : v)),
  notes: optional(10000),
  tags: z.string().max(1000).default(""),
});

function readMetadata(fd: FormData) {
  return metadataSchema.safeParse({
    title: fd.get("title") ?? "",
    description: fd.get("description") ?? "",
    category: fd.get("category") ?? "",
    notes: fd.get("notes") ?? "",
    tags: fd.get("tags") ?? "",
  });
}

async function replaceTags(supabase: Awaited<ReturnType<typeof createClient>>, workspaceId: string, referenceId: string, tags: string[]) {
  const { data: existing } = await supabase.from("reference_tags").select("tag").eq("reference_id", referenceId);
  const current = new Set((existing ?? []).map((t) => t.tag as string));
  const next = new Set(tags);
  const toDelete = [...current].filter((t) => !next.has(t));
  const toInsert = [...next].filter((t) => !current.has(t));
  if (toDelete.length) await supabase.from("reference_tags").delete().eq("reference_id", referenceId).in("tag", toDelete);
  if (toInsert.length) {
    const { error } = await supabase.from("reference_tags").insert(toInsert.map((tag) => ({ reference_id: referenceId, workspace_id: workspaceId, tag })));
    if (error) throw new Error(dbErrorMessage(error, "Could not save tags."));
  }
}

async function findDuplicate(supabase: Awaited<ReturnType<typeof createClient>>, workspaceId: string, normalized: string) {
  const { data } = await supabase.from("content_references").select("id, title").eq("workspace_id", workspaceId).eq("normalized_url", normalized).maybeSingle();
  return data as { id: string; title: string } | null;
}

// ---------------------------------------------------------------------------
// Import by URL
// ---------------------------------------------------------------------------
export async function importReferenceFromUrl(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = parseReferenceUrl(String(fd.get("url") ?? ""));
  if (!parsed.ok) return { status: "error", fieldErrors: { url: parsed.error } };
  const meta = readMetadata(fd);
  if (!meta.success) return { status: "error", fieldErrors: fieldErrors(meta.error) };
  const { tags, invalid } = normalizeTags(meta.data.tags);
  if (invalid.length) return { status: "error", fieldErrors: { tags: `Invalid tag(s): ${invalid.join(", ")}` } };

  const supabase = await createClient();
  const dup = await findDuplicate(supabase, ctx.workspace.id, parsed.normalized);
  if (dup) {
    return { status: "error", message: `This link is already in your library as “${dup.title}”.`, data: { existingId: dup.id } };
  }

  const check = await checkReferenceUrl(parsed);
  const title = meta.data.title || check.metadata?.title?.slice(0, 200) || (parsed.sourceType === "instagram" ? "Instagram reference" : parsed.sourceType === "youtube" ? "YouTube reference" : new URL(parsed.canonicalUrl).hostname);

  const { data, error } = await supabase
    .from("content_references")
    .insert({
      workspace_id: ctx.workspace.id,
      source_type: parsed.sourceType,
      provider: "manual",
      url: parsed.canonicalUrl,
      normalized_url: parsed.normalized,
      title,
      description: meta.data.description,
      author_name: check.metadata?.authorName?.slice(0, 200) ?? null,
      thumbnail_url: check.metadata?.thumbnailUrl ?? null,
      category: meta.data.category,
      notes: meta.data.notes,
      url_check: check,
      retrieved_at: check.metadata ? check.checkedAt : null,
      created_by: ctx.user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505") return { status: "error", message: "This link is already in your library." };
    return { status: "error", message: dbErrorMessage(error, "Could not save the reference.") };
  }
  await replaceTags(supabase, ctx.workspace.id, data.id, tags);
  revalidatePath("/discover", "layout");
  redirect(`/discover/references/${data.id}?imported=1`);
}

// ---------------------------------------------------------------------------
// Upload: create reference + reserve storage path; browser uploads directly
// ---------------------------------------------------------------------------
export type UploadStart = { ok: true; referenceId: string; path: string } | { ok: false; error: string; fieldErrors?: Record<string, string> };

export async function startUpload(input: {
  referenceId?: string;
  title: string;
  description?: string;
  category?: string;
  notes?: string;
  tags?: string;
  file: { name: string; type: string; size: number };
}): Promise<UploadStart> {
  const ctx = await getWorkspaceContext();
  const fileCheck = validateUploadMeta(input.file);
  if (!fileCheck.ok) return { ok: false, error: fileCheck.error };
  const supabase = await createClient();
  let referenceId = input.referenceId;

  if (referenceId) {
    if (!uuidSchema.safeParse(referenceId).success) return { ok: false, error: "Invalid reference." };
  } else {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ title: input.title, description: input.description, category: input.category, notes: input.notes, tags: input.tags })) fd.set(k, v ?? "");
    const meta = readMetadata(fd);
    if (!meta.success) return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(meta.error) };
    const { tags, invalid } = normalizeTags(meta.data.tags);
    if (invalid.length) return { ok: false, error: `Invalid tag(s): ${invalid.join(", ")}`, fieldErrors: { tags: "Invalid tags" } };
    const title = meta.data.title || input.file.name.replace(/\.[^.]+$/, "").slice(0, 200) || "Uploaded video";
    const { data, error } = await supabase
      .from("content_references")
      .insert({ workspace_id: ctx.workspace.id, source_type: "upload", provider: "manual", title, description: meta.data.description, category: meta.data.category, notes: meta.data.notes, created_by: ctx.user.id })
      .select("id")
      .single();
    if (error || !data) return { ok: false, error: dbErrorMessage(error, "Could not create the reference.") };
    referenceId = data.id as string;
    await replaceTags(supabase, ctx.workspace.id, referenceId, tags);
  }

  const { data: path, error } = await supabase.rpc("begin_reference_upload", {
    p_reference_id: referenceId,
    p_mime: fileCheck.mime,
    p_size_bytes: input.file.size,
  });
  if (error || typeof path !== "string") return { ok: false, error: dbErrorMessage(error, "Could not start the upload.") };
  return { ok: true, referenceId: referenceId!, path };
}

export async function finishUpload(referenceId: string, sha256: string | null): Promise<{ ok: true } | { ok: false; error: string; existingId?: string }> {
  const ctx = await getWorkspaceContext();
  if (!uuidSchema.safeParse(referenceId).success) return { ok: false, error: "Invalid reference." };
  const sha = sha256 && /^[0-9a-f]{64}$/.test(sha256) ? sha256 : null;
  const supabase = await createClient();
  const { error } = await supabase.rpc("complete_reference_upload", { p_reference_id: referenceId, p_sha256: sha });
  if (error) {
    if (error.code === "23505" && sha) {
      const { data } = await supabase.from("content_references").select("id").eq("workspace_id", ctx.workspace.id).eq("media_sha256", sha).maybeSingle();
      return { ok: false, error: "This exact video is already in your library.", existingId: data?.id };
    }
    return { ok: false, error: dbErrorMessage(error, "Could not finalize the upload.") };
  }
  revalidatePath("/discover", "layout");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Edit / delete
// ---------------------------------------------------------------------------
export async function updateReference(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("referenceId"));
  if (!id.success) return { status: "error", message: "Invalid reference." };
  const meta = readMetadata(fd);
  if (!meta.success) return { status: "error", fieldErrors: fieldErrors(meta.error) };
  if (!meta.data.title) return { status: "error", fieldErrors: { title: "Enter a title" } };
  const { tags, invalid } = normalizeTags(meta.data.tags);
  if (invalid.length) return { status: "error", fieldErrors: { tags: `Invalid tag(s): ${invalid.join(", ")}` } };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("content_references")
    .update({ title: meta.data.title, description: meta.data.description, category: meta.data.category, notes: meta.data.notes })
    .eq("id", id.data)
    .select("id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save changes.") };
  await replaceTags(supabase, ctx.workspace.id, id.data, tags);
  revalidatePath(`/discover/references/${id.data}`);
  return { status: "success", message: "Reference saved." };
}

export async function deleteReference(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("referenceId"));
  const supabase = await createClient();
  const { data: ref } = await supabase.from("content_references").select("id, workspace_id, media_path, thumbnail_path").eq("id", id).maybeSingle();
  if (!ref) redirect("/discover/library");
  const { data: analyses } = await supabase.from("video_analyses").select("id").eq("reference_id", id);

  const { data: deleted, error } = await supabase.from("content_references").delete().eq("id", id).select("id");
  if (error) throw new Error(dbErrorMessage(error));
  if (!deleted?.length) throw new Error("This reference cannot be deleted while an analysis is running.");

  // Storage cleanup: objects are now orphaned, which the storage policy allows deleting.
  const paths: string[] = [ref.media_path, ref.thumbnail_path].filter(Boolean) as string[];
  for (const a of analyses ?? []) {
    const prefix = `${ref.workspace_id}/analyses/${a.id}/frames`;
    const { data: files } = await supabase.storage.from("media").list(prefix, { limit: 1000 });
    for (const f of files ?? []) paths.push(`${prefix}/${f.name}`);
  }
  if (paths.length) await supabase.storage.from("media").remove(paths);
  revalidatePath("/discover", "layout");
  redirect("/discover/library?deleted=1");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------
const searchSchema = z.object({
  keywords: z.string().trim().max(150),
  niche: z.string().trim().max(80),
  industry: z.string().trim().max(80),
  topic: z.string().trim().max(80),
  format: z.enum(CONTENT_FORMATS.map((f) => f.id) as [string, ...string[]]),
  category: z.string().trim().max(60),
  providers: z.array(z.string()).min(1, "Select at least one source").max(10),
});

export async function runSearch(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const ctx = await getWorkspaceContext();
  const parsed = searchSchema.safeParse({
    keywords: fd.get("keywords") ?? "",
    niche: fd.get("niche") ?? "",
    industry: fd.get("industry") ?? "",
    topic: fd.get("topic") ?? "",
    format: fd.get("format") ?? "any",
    category: fd.get("category") ?? "",
    providers: fd.getAll("providers").map(String).filter((p) => DISCOVERY_PROVIDERS.some((d) => d.id === p)),
  });
  if (!parsed.success) return { status: "error", fieldErrors: fieldErrors(parsed.error) };
  const f = parsed.data;
  if (![f.keywords, f.niche, f.industry, f.topic].some(Boolean) && !f.providers.every((p) => p === "library")) {
    return { status: "error", fieldErrors: { keywords: "Enter keywords, a topic, niche or industry" } };
  }

  const supabase = await createClient();
  const query: DiscoveryQuery = {
    keywords: f.keywords,
    niche: f.niche || undefined,
    industry: f.industry || undefined,
    topic: f.topic || undefined,
    format: f.format as DiscoveryQuery["format"],
    category: f.category || undefined,
    limit: 20,
  };
  const runs = await runDiscovery(f.providers, query, {
    workspaceId: ctx.workspace.id,
    env: process.env,
    getInstagramToken: () => getWorkspaceInstagramToken(ctx.workspace.id),
    searchLibrary: async (q) => {
      const params = discoveryToLibraryParams(q);
      const base = supabase.from("content_references").select(`${librarySelect(params)}, description`).eq("workspace_id", ctx.workspace.id);
      const { data, error } = await applyLibraryFilters(base, params, q.limit);
      if (error) throw new Error(error.message);
      const now = new Date().toISOString();
      return ((data ?? []) as unknown as (LibraryRow & { description: string | null })[]).map((r) => libraryRowToResult(r, now));
    },
  });

  const results = runs.flatMap((r) => r.results);
  const errors = runs.filter((r) => r.status !== "ok").map((r) => ({ provider: r.provider, status: r.status, message: r.message }));
  const okCount = runs.filter((r) => r.status === "ok").length;
  const { data: search, error } = await supabase
    .from("discovery_searches")
    .insert({
      workspace_id: ctx.workspace.id,
      query: f.keywords,
      filters: { niche: f.niche, industry: f.industry, topic: f.topic, format: f.format, category: f.category },
      providers: f.providers,
      result_count: results.length,
      status: okCount === 0 ? "failed" : errors.length ? "partial" : "completed",
      errors,
      created_by: ctx.user.id,
    })
    .select("id")
    .single();
  if (error || !search) return { status: "error", message: dbErrorMessage(error, "Could not save the search.") };

  if (results.length) {
    const rows = results.map((r, i) => ({
      search_id: search.id,
      workspace_id: ctx.workspace.id,
      provider: r.provider,
      external_id: r.externalId,
      url: r.url,
      title: r.title.slice(0, 500),
      description: r.description?.slice(0, 5000) ?? null,
      author_name: r.authorName,
      thumbnail_url: r.thumbnailUrl,
      published_at: r.publishedAt,
      duration_seconds: r.durationSeconds,
      metrics: r.metrics,
      retrieved_at: r.retrievedAt,
      position: i,
    }));
    const { error: resErr } = await supabase.from("discovery_results").insert(rows);
    if (resErr) return { status: "error", message: dbErrorMessage(resErr, "Could not save results.") };
    // Library results are, by definition, already saved.
    const libIds = results.filter((r) => r.referenceId).map((r) => r.externalId);
    if (libIds.length) {
      for (const r of results.filter((x) => x.referenceId)) {
        await supabase.from("discovery_results").update({ reference_id: r.referenceId }).eq("search_id", search.id).eq("provider", "library").eq("external_id", r.externalId);
      }
    }
  }
  revalidatePath("/discover");
  redirect(`/discover/search/${search.id}`);
}

export async function saveSearch(_prev: ActionState, fd: FormData): Promise<ActionState> {
  await getWorkspaceContext();
  const id = uuidSchema.safeParse(fd.get("searchId"));
  const name = z.string().trim().min(1, "Name the search").max(80).safeParse(fd.get("name") ?? "");
  if (!id.success) return { status: "error", message: "Invalid search." };
  if (!name.success) return { status: "error", fieldErrors: { name: name.error.issues[0]?.message ?? "Invalid name" } };
  const supabase = await createClient();
  const { data, error } = await supabase.from("discovery_searches").update({ is_saved: true, name: name.data }).eq("id", id.data).select("id");
  if (error || !data?.length) return { status: "error", message: dbErrorMessage(error, "Could not save the search.") };
  revalidatePath("/discover", "layout");
  return { status: "success", message: "Search saved." };
}

export async function unsaveSearch(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("searchId"));
  const supabase = await createClient();
  await supabase.from("discovery_searches").update({ is_saved: false }).eq("id", id);
  revalidatePath("/discover", "layout");
}

export async function deleteSearch(fd: FormData): Promise<void> {
  await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("searchId"));
  const supabase = await createClient();
  await supabase.from("discovery_searches").delete().eq("id", id);
  revalidatePath("/discover", "layout");
}

/** Saves an external search result into the library (or links an existing one). */
export async function saveResultToLibrary(fd: FormData): Promise<void> {
  const ctx = await getWorkspaceContext();
  const id = uuidSchema.parse(fd.get("resultId"));
  const supabase = await createClient();
  const { data: r } = await supabase.from("discovery_results").select("*").eq("id", id).maybeSingle();
  if (!r) throw new Error("Result not found.");
  if (r.reference_id) redirect(`/discover/references/${r.reference_id}`);

  const parsed = r.url ? parseReferenceUrl(r.url) : null;
  const sourceType = r.provider === "youtube" ? "youtube" : r.provider.startsWith("instagram") ? "instagram" : "web";
  const normalized = parsed?.ok ? parsed.normalized : null;
  let referenceId: string | null = null;
  const existing = normalized ? await findDuplicate(supabase, ctx.workspace.id, normalized) : null;
  if (existing) referenceId = existing.id;
  else {
    const { data, error } = await supabase
      .from("content_references")
      .insert({
        workspace_id: ctx.workspace.id,
        source_type: sourceType,
        provider: r.provider,
        external_id: r.external_id,
        url: parsed?.ok ? parsed.canonicalUrl : r.url,
        normalized_url: normalized,
        title: (r.title as string).slice(0, 200) || "Untitled",
        description: r.description,
        author_name: r.author_name,
        thumbnail_url: r.thumbnail_url,
        duration_seconds: r.duration_seconds,
        metrics: r.metrics,
        retrieved_at: r.retrieved_at,
        url_check: { status: "not_checked", note: `Imported from ${r.provider} search results.`, checkedAt: r.retrieved_at },
        created_by: ctx.user.id,
      })
      .select("id")
      .single();
    if (error?.code === "23505") {
      const { data: dup } = await supabase.from("content_references").select("id").eq("workspace_id", ctx.workspace.id).eq("provider", r.provider).eq("external_id", r.external_id).maybeSingle();
      referenceId = dup?.id ?? null;
    } else if (error || !data) throw new Error(dbErrorMessage(error, "Could not save to library."));
    else referenceId = data.id;
  }
  if (referenceId) await supabase.from("discovery_results").update({ reference_id: referenceId }).eq("id", id);
  revalidatePath(`/discover/search/${r.search_id}`);
}
