import type { ReactNode } from "react";
import { DiscoverNav } from "@/components/discover/discover-nav";

export default function DiscoverLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <DiscoverNav />
      {children}
    </>
  );
}
