import { Skeleton } from "@/components/ui/states";

export default function Loading() {
  return <div aria-busy="true" className="space-y-4"><span className="sr-only">Loading…</span><Skeleton className="h-10 w-64" /><Skeleton className="h-48" /><Skeleton className="h-48" /></div>;
}
