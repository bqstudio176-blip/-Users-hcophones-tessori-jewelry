import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

type Tone = "info" | "success" | "warning" | "danger";
const tones: Record<Tone, string> = {
  info: "border-info/30 bg-info/10 text-fg",
  success: "border-success/30 bg-success/10 text-fg",
  warning: "border-warning/30 bg-warning/10 text-fg",
  danger: "border-danger/30 bg-danger/10 text-fg",
};
const dots: Record<Tone, string> = { info: "bg-info", success: "bg-success", warning: "bg-warning", danger: "bg-danger" };

export function Alert({ tone = "info", title, children, className }: { tone?: Tone; title?: string; children?: ReactNode; className?: string }) {
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("flex gap-3 rounded-md border px-4 py-3 text-sm", tones[tone], className)}>
      <span aria-hidden className={cn("mt-1.5 size-2 shrink-0 rounded-full", dots[tone])} />
      <div className="space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className="text-fg-muted">{children}</div>}
      </div>
    </div>
  );
}
