-- =============================================================================
-- Content OS — Phase 2 — Migration 0800: private media bucket + storage RLS
--
-- Object layout (first folder is always the workspace id):
--   <workspace_id>/references/<reference_id>/<uuid>.<ext>   uploaded videos
--   <workspace_id>/analyses/<analysis_id>/frames/<n>.jpg    representative frames
--
-- The bucket is private: the browser only ever receives short-lived signed
-- URLs. Uploads are allowed only to the exact path reserved by
-- begin_reference_upload(). Size and MIME limits are also enforced by Storage.
-- =============================================================================

-- Extracts the workspace id (first path segment) or NULL if malformed.
create or replace function public.storage_workspace_id(p_name text)
returns uuid
language sql
immutable
set search_path = ''
as $$
  select case
    when split_part(p_name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then split_part(p_name, '/', 1)::uuid
    else null
  end;
$$;
grant execute on function public.storage_workspace_id(text) to authenticated, service_role;

do $$
begin
  if not exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'objects') then
    raise notice 'storage schema not present; skipping bucket and storage policies';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('media', 'media', false, 209715200,
          array['video/mp4', 'video/quicktime', 'video/webm', 'image/jpeg'])
  on conflict (id) do update
    set public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- Read (needed to mint signed URLs): any member of the path's workspace.
  create policy media_select_member on storage.objects
    for select to authenticated
    using (bucket_id = 'media' and public.is_workspace_member(public.storage_workspace_id(name)));

  -- Upload: only to a path reserved by begin_reference_upload() for a
  -- reference the caller can access.
  create policy media_insert_reserved on storage.objects
    for insert to authenticated
    with check (
      bucket_id = 'media'
      and exists (
        select 1 from public.content_references r
        where r.media_path = name
          and r.media_status = 'pending_upload'
          and public.is_workspace_member(r.workspace_id)
      )
    );

  -- Delete: members may remove only orphaned objects (whose reference /
  -- analysis row has already been deleted) or a pending upload.
  create policy media_delete_orphan on storage.objects
    for delete to authenticated
    using (
      bucket_id = 'media'
      and public.is_workspace_member(public.storage_workspace_id(name))
      and not exists (
        select 1 from public.content_references r
        where r.media_path = name and r.media_status <> 'pending_upload'
      )
      and not exists (
        select 1 from public.video_analyses a
        where split_part(name, '/', 2) = 'analyses' and a.id::text = split_part(name, '/', 3)
      )
    );
end $$;
