"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/admin", label: "Overview" },
  { href: "/admin/workspaces", label: "Workspaces" },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/activity", label: "Activity" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Admin" className="flex gap-1 overflow-x-auto">
      {ITEMS.map((i) => {
        const active = i.href === "/admin" ? pathname === "/admin" : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined}
            className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm", active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
