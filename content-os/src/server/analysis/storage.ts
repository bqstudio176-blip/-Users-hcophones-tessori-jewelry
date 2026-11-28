import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { RetryableError } from "./errors";

/** Where the worker reads uploaded videos and writes frames. */
export interface MediaStore {
  download(objectPath: string, destFile: string): Promise<void>;
  upload(objectPath: string, srcFile: string, contentType: string): Promise<void>;
}

export const MEDIA_BUCKET = "media";

/** Supabase Storage (service role, worker only). */
export class SupabaseMediaStore implements MediaStore {
  private client: SupabaseClient;
  constructor(url: string, serviceRoleKey: string) {
    this.client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async download(objectPath: string, destFile: string) {
    const { data, error } = await this.client.storage.from(MEDIA_BUCKET).download(objectPath);
    if (error || !data) throw new RetryableError(`Could not download media: ${error?.message ?? "no data"}`);
    await writeFile(destFile, Buffer.from(await data.arrayBuffer()));
  }
  async upload(objectPath: string, srcFile: string, contentType: string) {
    const { error } = await this.client.storage.from(MEDIA_BUCKET).upload(objectPath, await readFile(srcFile), { contentType, upsert: true });
    if (error) throw new RetryableError(`Could not upload ${objectPath}: ${error.message}`);
  }
}

/** Local directory store for tests and offline development. Paths are confined to the root. */
export class LocalMediaStore implements MediaStore {
  constructor(private root: string) {}
  private resolve(objectPath: string) {
    const full = path.resolve(this.root, objectPath);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Path escapes media root");
    return full;
  }
  async download(objectPath: string, destFile: string) {
    await copyFile(this.resolve(objectPath), destFile);
  }
  async upload(objectPath: string, srcFile: string) {
    const dest = this.resolve(objectPath);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(srcFile, dest);
  }
}
