import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ComingSoon } from "@/components/app/coming-soon";
import { findModule } from "@/lib/navigation";

const mod = findModule("/analyze");
export const metadata: Metadata = { title: mod?.label };

export default function Page() {
  if (!mod) notFound();
  return <ComingSoon module={mod} />;
}
