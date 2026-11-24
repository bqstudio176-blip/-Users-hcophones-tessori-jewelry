import type { IconName } from "@/components/ui/icons";

export type ModuleStatus = "available" | "coming_soon";

export interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  status: ModuleStatus;
  description: string;
}

/**
 * Primary navigation. Modules are flipped to "available" only when actually
 * implemented — never before (no fake functionality).
 */
export const PRIMARY_NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: "overview", status: "available", description: "Workspace health, usage and next steps." },
  { href: "/discover", label: "Discover", icon: "discover", status: "available", description: "Find, import and organize content references." },
  { href: "/analyze", label: "Analyze", icon: "analyze", status: "available", description: "AI breakdowns of hooks, storytelling, retention structure and editing." },
  { href: "/script-lab", label: "Script Lab", icon: "scriptLab", status: "coming_soon", description: "Draft, iterate and approve scripts in your brand voice." },
  { href: "/video-studio", label: "Video Studio", icon: "videoStudio", status: "coming_soon", description: "Turn approved scripts into ready-to-post videos." },
  { href: "/experiments", label: "Experiments", icon: "experiments", status: "coming_soon", description: "A/B test hooks, captions and posting times." },
  { href: "/publish", label: "Publish", icon: "publish", status: "coming_soon", description: "Schedule and publish to your connected Instagram account." },
  { href: "/analytics", label: "Analytics", icon: "analytics", status: "coming_soon", description: "Track performance across everything you ship." },
];

export const SECONDARY_NAV: NavItem[] = [
  { href: "/settings", label: "Settings", icon: "settings", status: "available", description: "Profile, workspace, members, connections and security." },
];

export function findModule(href: string): NavItem | undefined {
  return PRIMARY_NAV.find((n) => n.href === href);
}

export const SETTINGS_NAV = [
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/workspace", label: "Workspace" },
  { href: "/settings/members", label: "Members" },
  { href: "/settings/connections", label: "Connections" },
  { href: "/settings/billing", label: "Plan & usage" },
  { href: "/settings/security", label: "Security" },
  { href: "/settings/preferences", label: "Preferences" },
] as const;
