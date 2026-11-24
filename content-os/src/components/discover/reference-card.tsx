import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { ANALYSIS_STATUS_LABELS, SOURCE_LABELS } from "@/lib/discover/catalog";
import { formatDate, formatDuration } from "@/lib/format";

export interface ReferenceCardData {
  id: string;
  title: string;
  source_type: string;
  author_name: string | null;
  thumbnail_url: string | null;
  thumbnail_path: string | null;
  duration_seconds: number | string | null;
  category: string | null;
  media_status: string;
  analysis_status: string;
  created_at: string;
  reference_tags?: { tag: string }[];
}

export const ANALYSIS_TONE: Record<string, BadgeTone> = { not_analyzed: "neutral", queued: "info", processing: "info", analyzed: "success", failed: "danger" };

export function Thumbnail({ src, alt, className = "" }: { src: string | null; alt: string; className?: string }) {
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- external/signed URLs; no optimization proxy for private media
    <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className={`h-full w-full object-cover ${className}`} />
  ) : (
    <div className={`grid h-full w-full place-items-center bg-surface-3 text-xs text-fg-subtle ${className}`}>No preview</div>
  );
}

export function ReferenceCard({ r, thumbnail }: { r: ReferenceCardData; thumbnail: string | null }) {
  return (
    <Link href={`/discover/references/${r.id}`} className="group flex flex-col overflow-hidden rounded-lg border border-line bg-surface hover:border-line-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <div className="relative aspect-video bg-surface-2">
        <Thumbnail src={thumbnail} alt="" />
        {r.duration_seconds !== null && <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-white">{formatDuration(r.duration_seconds)}</span>}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium text-fg group-hover:text-accent">{r.title}</p>
        <p className="text-xs text-fg-subtle">
          {SOURCE_LABELS[r.source_type] ?? r.source_type}
          {r.author_name ? ` · ${r.author_name}` : ""} · {formatDate(r.created_at)}
        </p>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          <Badge tone={ANALYSIS_TONE[r.analysis_status] ?? "neutral"}>{ANALYSIS_STATUS_LABELS[r.analysis_status] ?? r.analysis_status}</Badge>
          {r.media_status !== "uploaded" && <Badge>No video file</Badge>}
          {r.category && <Badge tone="accent">{r.category}</Badge>}
          {(r.reference_tags ?? []).slice(0, 3).map((t) => <Badge key={t.tag}>#{t.tag}</Badge>)}
        </div>
      </div>
    </Link>
  );
}
