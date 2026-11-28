"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icons } from "@/components/ui/icons";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { cancelAnalysis } from "@/server/actions/analyze";

type Step = { step: string; status: "pending" | "running" | "done" | "skipped" | "failed"; detail?: string };
interface StatusPayload {
  status: "queued" | "processing" | "completed" | "failed" | "canceled";
  error: string | null;
  job: { status: string; current_step: string | null; steps: Step[]; attempts: number; max_attempts: number; last_error: string | null; cancel_requested: boolean; run_after: string } | null;
  logs: { id: number; level: string; step: string | null; message: string; created_at: string }[];
}

const LABELS: Record<string, string> = {
  validate: "Validate input",
  media: "Process media",
  scenes: "Detect scenes",
  transcription: "Transcribe audio",
  visual: "Analyze frames",
  analysis: "AI content analysis",
  report: "Generate report",
};
const ORDER = Object.keys(LABELS);

/**
 * Polls the real job state every 3 s. Shows which steps have actually
 * finished — "N of 7 steps" — never an invented percentage.
 */
export function ProcessingView({ analysisId, initial, canCancel }: { analysisId: string; initial: StatusPayload; canCancel: boolean }) {
  const router = useRouter();
  const [data, setData] = useState<StatusPayload>(initial);
  const [pollError, setPollError] = useState(false);
  const active = data.status === "queued" || data.status === "processing";
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!active) {
      router.refresh();
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch(`/api/analyses/${analysisId}/status`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const next = (await res.json()) as StatusPayload;
        if (!cancelled) {
          setData(next);
          setPollError(false);
        }
      } catch {
        if (!cancelled) setPollError(true);
      }
      if (!cancelled) timer.current = setTimeout(tick, 3000);
    };
    timer.current = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, analysisId, router]);

  const steps: Step[] = ORDER.map((id) => data.job?.steps?.find((s) => s.step === id) ?? { step: id, status: "pending" });
  const finished = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
  const retrying = data.job?.status === "queued" && (data.job?.attempts ?? 0) > 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle>{data.status === "queued" ? (retrying ? "Waiting to retry" : "Queued") : "Processing"}</CardTitle>
            <CardDescription>
              {finished} of {steps.length} steps finished
              {data.job && data.job.attempts > 0 ? ` · attempt ${data.job.attempts} of ${data.job.max_attempts}` : ""}
            </CardDescription>
          </div>
          {canCancel && active && (
            <form action={cancelAnalysis}>
              <input type="hidden" name="analysisId" value={analysisId} />
              <Button type="submit" variant="outline" size="sm" disabled={data.job?.cancel_requested}>
                {data.job?.cancel_requested ? "Cancelling…" : "Cancel analysis"}
              </Button>
            </form>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {data.status === "queued" && !retrying && <Alert tone="info">Waiting for a worker. Processing starts automatically; you can leave this page.</Alert>}
        {retrying && data.job?.last_error && <Alert tone="warning" title="A step failed and will be retried automatically">{data.job.last_error}</Alert>}
        {pollError && <Alert tone="warning">Could not refresh progress. Retrying…</Alert>}
        <ol className="space-y-2" aria-live="polite">
          {steps.map((s) => (
            <li key={s.step} className="flex items-start gap-3">
              <span className={cn("mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                s.status === "done" && "border-success bg-success/15 text-success",
                s.status === "skipped" && "border-line-strong text-fg-subtle",
                s.status === "running" && "border-accent text-accent",
                s.status === "failed" && "border-danger bg-danger/15 text-danger",
                s.status === "pending" && "border-line")}>
                {s.status === "done" ? <Icons.check width={12} height={12} /> : s.status === "running" ? <Spinner className="size-3" label="Running" /> : s.status === "failed" ? <Icons.close width={12} height={12} /> : null}
              </span>
              <div className="min-w-0">
                <p className={cn("text-sm", s.status === "pending" ? "text-fg-subtle" : "text-fg")}>
                  {LABELS[s.step]} {s.status === "skipped" && <Badge className="ml-1">Skipped</Badge>}
                </p>
                {s.detail && <p className="text-xs text-fg-muted">{s.detail}</p>}
              </div>
            </li>
          ))}
        </ol>
        {data.logs.length > 0 && (
          <details>
            <summary className="cursor-pointer text-xs text-fg-muted">Processing log ({data.logs.length})</summary>
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto rounded-md bg-surface-2 p-3 font-mono text-[11px]">
              {data.logs.map((l) => (
                <li key={l.id} className={l.level === "error" ? "text-danger" : l.level === "warn" ? "text-warning" : "text-fg-muted"}>
                  {new Date(l.created_at).toLocaleTimeString()} {l.step ? `[${l.step}] ` : ""}{l.message}
                </li>
              ))}
            </ul>
          </details>
        )}
      </CardContent>
    </Card>
  );
}
