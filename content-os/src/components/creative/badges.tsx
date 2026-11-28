import { Badge, type BadgeTone } from "@/components/ui/badge";

const PROV: Record<string, { tone: BadgeTone; label: string; title: string }> = {
  observed: { tone: "success", label: "Observed", title: "A fact from your analyzed references" },
  user: { tone: "info", label: "You provided", title: "Something you stated in the strategy" },
  hypothesis: { tone: "warning", label: "AI hypothesis", title: "The model's own inference — validate it" },
};

export function ProvenanceBadge({ type, children }: { type: string; children?: React.ReactNode }) {
  const p = PROV[type] ?? PROV.hypothesis!;
  return <Badge tone={p.tone} title={p.title}>{p.label}{children ? <>: {children}</> : null}</Badge>;
}

const EVIDENCE: Record<string, { tone: BadgeTone; label: string }> = {
  established_principle: { tone: "success", label: "Established principle" },
  practitioner_heuristic: { tone: "info", label: "Practitioner heuristic" },
  experimental: { tone: "warning", label: "Experimental" },
};
export function EvidenceBadge({ type }: { type: string }) {
  const e = EVIDENCE[type] ?? { tone: "neutral" as const, label: type };
  return <Badge tone={e.tone}>{e.label}</Badge>;
}

const STATUS: Record<string, BadgeTone> = { approved: "success", pending_approval: "warning", draft: "neutral", disabled: "danger" };
export function RuleStatusBadge({ status }: { status: string }) {
  return <Badge tone={STATUS[status] ?? "neutral"} className="capitalize">{status.replace(/_/g, " ")}</Badge>;
}
