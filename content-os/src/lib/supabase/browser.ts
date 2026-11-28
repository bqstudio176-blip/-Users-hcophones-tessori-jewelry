"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser client acting as the signed-in user (session from cookies). Used
 * only for direct-to-Storage uploads; RLS restricts uploads to the path the
 * server reserved with begin_reference_upload().
 */
export function createClient() {
  return createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}
