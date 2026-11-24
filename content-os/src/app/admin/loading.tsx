import { Skeleton } from "@/components/ui/states";

export default function Loading() {
  return <div aria-busy="true" className="space-y-4"><span className="sr-only">Loading…</span><Skeleton className="h-24" /><Skeleton className="h-72" /></div>;
}
