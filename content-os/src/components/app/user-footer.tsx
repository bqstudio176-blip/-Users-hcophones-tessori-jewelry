import Link from "next/link";
import { Icons } from "@/components/ui/icons";
import type { Profile } from "@/lib/types";
import { signOut } from "@/server/actions/auth";

export function UserFooter({ profile }: { profile: Profile }) {
  const name = profile.full_name || profile.email;
  return (
    <div className="flex items-center gap-2">
      <Link href="/settings/profile" className="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:bg-surface-2">
        <span aria-hidden className="grid size-8 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold text-fg">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-fg">{name}</span>
          <span className="block truncate text-[11px] text-fg-subtle">{profile.email}</span>
        </span>
      </Link>
      <form action={signOut}>
        <button type="submit" aria-label="Sign out" title="Sign out" className="rounded-md p-2 text-fg-subtle hover:bg-surface-2 hover:text-fg">
          <Icons.logout />
        </button>
      </form>
    </div>
  );
}
