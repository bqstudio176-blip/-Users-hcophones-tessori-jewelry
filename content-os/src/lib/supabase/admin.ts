import "server-only";
import { createClient } from "@supabase/supabase-js";
import { publicEnv, serverEnv } from "@/lib/env";

/**
 * SERVICE-ROLE client. Bypasses RLS. Use ONLY for operations that cannot be
 * expressed as the user (currently: writing encrypted social credentials after
 * a verified OAuth exchange). Never import from client components; the
 * `server-only` import makes that a build error.
 *
 * Callers MUST perform their own authorization check before using it.
 */
export function createAdminClient() {
  return createClient(publicEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
