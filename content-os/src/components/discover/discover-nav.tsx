"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/discover", label: "Overview", exact: true },
  { href: "/discover/library", label: "Library" },
  { href: "/discover/import", label: "Import" },
  { href: "/discover/sources", label: "Sources" },
];

export function DiscoverNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Discover" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {ITEMS.map((i) => {
        const active = i.exact ? pathname === i.href : pathname.startsWith(i.href);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
