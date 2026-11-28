"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/cn";

const ITEMS = [
  { href: "/video-studio", label: "Videos", match: (p: string) => p === "/video-studio" || (/^\/video-studio\/[0-9a-f-]{36}/.test(p)) },
  { href: "/video-studio/media", label: "Media library", match: (p: string) => p.startsWith("/video-studio/media") },
];

export function VideoStudioNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Video Studio" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
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

/** Tabs inside one video. */
export function VideoProjectNav({ id }: { id: string }) {
  const pathname = usePathname();
  const tabs = [
    { href: `/video-studio/${id}`, label: "Editor", exact: true },
    { href: `/video-studio/${id}/voiceover`, label: "Voiceover" },
    { href: `/video-studio/${id}/renders`, label: "Render & checks" },
    { href: `/video-studio/${id}/versions`, label: "Versions" },
  ];
  return (
    <nav aria-label="Video" className="mb-4 flex gap-1 overflow-x-auto">
      {tabs.map((t) => {
        const active = t.exact ? pathname === t.href : pathname.startsWith(t.href);
        return (
          <Link key={t.href} href={t.href} aria-current={active ? "page" : undefined} className={cn("whitespace-nowrap rounded-md px-3 py-1.5 text-sm", active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg")}>
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
