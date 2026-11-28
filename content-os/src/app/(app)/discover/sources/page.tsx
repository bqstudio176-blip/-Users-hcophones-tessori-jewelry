import type { Metadata } from "next";
import { Badge } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { providerAvailability } from "@/server/discovery/availability";

export const metadata: Metadata = { title: "Discovery sources" };

export default async function SourcesPage() {
  const ctx = await getWorkspaceContext();
  const providers = await providerAvailability(ctx.workspace.id);
  return (
    <>
      <PageHeader title="Discovery sources" description="What each source can do, what it needs and its limits. Unavailable sources are never simulated." />
      <div className="space-y-4">
        {providers.map(({ provider: p, availability: a }) => (
          <Card key={p.id}>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <CardTitle>{p.name}</CardTitle>
                <div className="flex items-center gap-2">
                  {a.available ? <Badge tone="success">Available</Badge> : <Badge tone="warning">Not available</Badge>}
                  {!a.available && a.action && <ButtonLink href={a.action.href} size="sm" variant="outline">{a.action.label}</ButtonLink>}
                </div>
              </div>
              {!a.available && <p className="text-xs text-fg-muted">{a.reason}</p>}
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4 text-sm md:grid-cols-2">
                <div><dt className="text-xs text-fg-subtle">Capabilities</dt><dd><ul className="list-disc pl-4 text-fg">{p.docs.capabilities.map((c) => <li key={c}>{c}</li>)}</ul></dd></div>
                <div><dt className="text-xs text-fg-subtle">Available metadata</dt><dd className="text-fg">{p.docs.metadata.join(", ")}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Authentication</dt><dd className="text-fg">{p.docs.authentication}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Rate limits</dt><dd className="text-fg">{p.docs.rateLimits}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Usage restrictions</dt><dd className="text-fg">{p.docs.restrictions}</dd></div>
                <div><dt className="text-xs text-fg-subtle">Costs</dt><dd className="text-fg">{p.docs.costs}</dd></div>
              </dl>
              {p.docs.docsUrl && <a href={p.docs.docsUrl} target="_blank" rel="noopener noreferrer" className="mt-3 inline-block text-xs text-accent hover:text-accent-hover">Provider documentation ↗</a>}
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}
