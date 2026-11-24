import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/app/admin-nav";
import { Badge } from "@/components/ui/badge";
import { requirePlatformAdmin } from "@/lib/auth/session";

export const metadata: Metadata = { title: { default: "Admin", template: "%s · Admin · Content OS" } };

/**
 * Platform admin area. requirePlatformAdmin() responds 404 for everyone else.
 * Cross-tenant reads are authorised by RLS policies that call
 * public.is_platform_admin() — no service-role key is used here.
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const { profile } = await requirePlatformAdmin();
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div className="flex items-center gap-3">
            <Link href="/dashboard" className="text-sm font-semibold text-fg">Content OS</Link>
            <Badge tone="danger">Platform admin</Badge>
          </div>
          <AdminNav />
          <span className="hidden text-xs text-fg-subtle lg:block">{profile.email}</span>
        </div>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
