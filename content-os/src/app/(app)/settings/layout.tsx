import type { ReactNode } from "react";
import { SettingsNav } from "@/components/app/settings-nav";
import { PageHeader } from "@/components/ui/states";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageHeader title="Settings" description="Manage your account and this workspace." />
      <div className="grid gap-6 lg:grid-cols-[12rem_1fr]">
        <SettingsNav />
        <div className="min-w-0 space-y-6">{children}</div>
      </div>
    </>
  );
}
