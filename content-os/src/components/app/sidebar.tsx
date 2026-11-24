"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Icons } from "@/components/ui/icons";
import { cn } from "@/lib/cn";
import { PRIMARY_NAV, SECONDARY_NAV, type NavItem } from "@/lib/navigation";

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = Icons[item.icon];
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group flex items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors",
        active ? "bg-surface-3 text-fg" : "text-fg-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon className={cn(active ? "text-accent" : "text-fg-subtle group-hover:text-fg-muted")} />
      <span className="flex-1">{item.label}</span>
      {item.status === "coming_soon" && <Badge className="px-1.5 text-[10px]">Soon</Badge>}
    </Link>
  );
}

export function Sidebar({ header, footer, isPlatformAdmin }: { header: ReactNode; footer: ReactNode; isPlatformAdmin: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  const nav = (
    <div className="flex h-full flex-col">
      <div className="px-3 pt-4">{header}</div>
      <nav aria-label="Primary" className="mt-4 flex-1 space-y-0.5 overflow-y-auto px-3">
        {PRIMARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
        <div className="my-3 border-t border-line" />
        {SECONDARY_NAV.map((item) => (
          <NavLink key={item.href} item={item} active={isActive(item.href)} />
        ))}
        {isPlatformAdmin && (
          <NavLink item={{ href: "/admin", label: "Admin", icon: "shield", status: "available", description: "" }} active={isActive("/admin")} />
        )}
      </nav>
      <div className="border-t border-line p-3">{footer}</div>
    </div>
  );

  return (
    <>
      {/* Mobile top bar */}
      <div className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-line bg-bg/90 px-4 backdrop-blur lg:hidden">
        <span className="text-sm font-semibold text-fg">Content OS</span>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          aria-label={open ? "Close navigation" : "Open navigation"}
          className="rounded-md p-2 text-fg-muted hover:bg-surface-2 hover:text-fg"
        >
          {open ? <Icons.close /> : <Icons.menu />}
        </button>
      </div>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <aside id="mobile-nav" className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface">
            {nav}
          </aside>
        </div>
      )}

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 border-r border-line bg-surface lg:block">{nav}</aside>
    </>
  );
}
