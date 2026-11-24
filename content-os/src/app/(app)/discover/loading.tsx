import { Skeleton } from "@/components/ui/states";

export default function Loading() {
  return (
    <div aria-busy="true" className="space-y-4">
      <span className="sr-only">Loading…</span>
      <Skeleton className="h-11" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="aspect-video" />)}</div>
    </div>
  );
}
