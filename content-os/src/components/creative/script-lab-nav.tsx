"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/script-lab", label: "Creative intelligence", match: (p: string) => p === "/script-lab" || p.startsWith("/script-lab/projects") || p.startsWith("/script-lab/scripts") },
  { href: "/script-lab/rules", label: "Creative rules", match: (p: string) => p.startsWith("/script-lab/rules") },
  { href: "/script-lab/feedback", label: "Feedback & preferences", match: (p: string) => p.startsWith("/script-lab/feedback") },
  { href: "/script-lab/usage", label: "AI usage", match: (p: string) => p.startsWith("/script-lab/usage") },
];

export function ScriptLabNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Script Lab" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {ITEMS.map((i) => {
        const active = i.match(pathname);
        return (
          <Link key={i.href} href={i.href} aria-current={active ? "page" : undefined} className={cn("-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm", active ? "border-accent text-fg" : "border-transparent text-fg-muted hover:text-fg")}>
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
