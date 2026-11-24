import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Icons } from "@/components/ui/icons";
import type { NavItem } from "@/lib/navigation";

/** Honest placeholder for modules that are not built yet. No fake data. */
export function ComingSoon({ module }: { module: NavItem }) {
  const Icon = Icons[module.icon];
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center py-16 text-center">
      <div className="grid size-14 place-items-center rounded-xl border border-line bg-surface-2 text-accent">
        <Icon width={26} height={26} />
      </div>
      <Badge tone="accent" className="mt-5">Coming soon</Badge>
      <h1 className="mt-3 text-2xl font-semibold tracking-tight text-fg">{module.label}</h1>
      <p className="mt-2 text-sm text-fg-muted">{module.description}</p>
      <p className="mt-4 text-xs text-fg-subtle">
        This module is planned for a later phase and is not available yet. Nothing on this page is functional.
      </p>
      <ButtonLink href="/dashboard" variant="outline" className="mt-6">Back to overview</ButtonLink>
    </div>
  );
}
