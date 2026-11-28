import type { ReactNode } from "react";
import { Sidebar } from "@/components/app/sidebar";
import { UserFooter } from "@/components/app/user-footer";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { getWorkspaceContext } from "@/lib/auth/session";

/** Every route in this group requires a verified user with a workspace. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const ctx = await getWorkspaceContext();
  return (
    <div className="min-h-dvh">
      <Sidebar
        isPlatformAdmin={ctx.profile.is_platform_admin}
        header={<WorkspaceSwitcher current={ctx.workspace} memberships={ctx.memberships} />}
        footer={<UserFooter profile={ctx.profile} />}
      />
      <main id="main" className="lg:pl-64">
        <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-10">{children}</div>
      </main>
    </div>
  );
}
