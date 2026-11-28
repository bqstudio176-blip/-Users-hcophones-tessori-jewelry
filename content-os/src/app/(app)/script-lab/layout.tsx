import type { ReactNode } from "react";
import { ScriptLabNav } from "@/components/creative/script-lab-nav";

// AI generations can take up to a few minutes; allow long-running server actions.
export const maxDuration = 300;

export default function ScriptLabLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <ScriptLabNav />
      {children}
    </>
  );
}
