import type { Metadata } from "next";
import Link from "next/link";
import { ImportUrlForm, UploadForm } from "@/components/discover/import-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";
import { cn } from "@/lib/cn";

export const metadata: Metadata = { title: "Import reference" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  await getWorkspaceContext();
  const { tab } = await searchParams;
  const upload = tab === "upload";
  return (
    <>
      <PageHeader title="Import a reference" description="Save a link to research it, or upload a video file to analyze it." />
      <div role="tablist" aria-label="Import method" className="mb-4 inline-flex rounded-md border border-line bg-surface p-1">
        {[{ id: "url", label: "Paste a URL" }, { id: "upload", label: "Upload a video" }].map((t) => {
          const selected = (t.id === "upload") === upload;
          return (
            <Link key={t.id} role="tab" aria-selected={selected} href={t.id === "upload" ? "/discover/import?tab=upload" : "/discover/import"} className={cn("rounded px-3 py-1.5 text-sm", selected ? "bg-surface-3 text-fg" : "text-fg-muted hover:text-fg")}>
              {t.label}
            </Link>
          );
        })}
      </div>
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>{upload ? "Upload a video" : "Import from a URL"}</CardTitle>
          <CardDescription>{upload ? "The video is stored privately in this workspace and can be analyzed." : "Instagram and YouTube links are checked for accessibility. Other links are saved as-is."}</CardDescription>
        </CardHeader>
        <CardContent>{upload ? <UploadForm /> : <ImportUrlForm />}</CardContent>
      </Card>
    </>
  );
}
