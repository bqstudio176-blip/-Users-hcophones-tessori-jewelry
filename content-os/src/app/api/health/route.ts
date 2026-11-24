import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness probe. Reports configuration presence only — never values. */
export function GET() {
  return NextResponse.json({
    status: "ok",
    supabaseConfigured: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    time: new Date().toISOString(),
  });
}
