import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main" className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-accent/20 blur-3xl" />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex items-center justify-center gap-2">
          <span aria-hidden className="grid size-8 place-items-center rounded-lg bg-accent text-sm font-bold text-accent-fg">C</span>
          <span className="text-base font-semibold tracking-tight text-fg">Content OS</span>
        </div>
        <div className="rounded-lg border border-line bg-surface p-6 shadow-elevated">{children}</div>
      </div>
    </main>
  );
}
