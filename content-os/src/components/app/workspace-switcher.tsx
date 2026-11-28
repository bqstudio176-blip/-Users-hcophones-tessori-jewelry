import Link from "next/link";
import { Icons } from "@/components/ui/icons";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import type { Membership, WorkspaceSummary } from "@/lib/types";
import { switchWorkspace } from "@/server/actions/workspace";

/** Native <details> disclosure: keyboard accessible, no client JS required. */
export function WorkspaceSwitcher({ current, memberships }: { current: WorkspaceSummary; memberships: Membership[] }) {
  const currentRole = memberships.find((m) => m.workspace.id === current.id)?.role;
  return (
    <details className="group relative">
      <summary className="flex cursor-pointer list-none items-center gap-3 rounded-md border border-line bg-surface-2 px-2.5 py-2 hover:border-line-strong [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="grid size-7 place-items-center rounded-md bg-accent/20 text-xs font-semibold text-accent">
          {current.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{current.name}</span>
          <span className="block text-[11px] text-fg-subtle">{currentRole ? ROLE_LABELS[currentRole] : ""}</span>
        </span>
        <Icons.chevronDown className="text-fg-subtle transition-transform group-open:rotate-180" />
        <span className="sr-only">Switch workspace</span>
      </summary>
      <div className="absolute inset-x-0 z-50 mt-1 rounded-md border border-line bg-surface-2 p-1 shadow-elevated">
        <p className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Workspaces</p>
        <ul>
          {memberships.map((m) => (
            <li key={m.workspace.id}>
              <form action={switchWorkspace}>
                <input type="hidden" name="workspaceId" value={m.workspace.id} />
                <button
                  type="submit"
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-fg-muted hover:bg-surface-3 hover:text-fg"
                  aria-current={m.workspace.id === current.id ? "true" : undefined}
                >
                  <span className="flex-1 truncate">{m.workspace.name}</span>
                  {m.workspace.id === current.id && <Icons.check className="text-accent" width={14} height={14} />}
                </button>
              </form>
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          <Link href="/onboarding?new=1" className="flex items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-muted hover:bg-surface-3 hover:text-fg">
            <Icons.plus width={14} height={14} /> New workspace
          </Link>
        </div>
      </div>
    </details>
  );
}
