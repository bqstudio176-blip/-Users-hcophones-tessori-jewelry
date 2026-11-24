"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { Spinner } from "@/components/ui/spinner";
import { SubmitButton } from "@/components/ui/submit-button";
import { REFERENCE_CATEGORIES } from "@/lib/discover/catalog";
import { formatBytes, MAX_UPLOAD_BYTES, sniffVideoContainer, validateUploadMeta } from "@/lib/discover/upload";
import { createClient } from "@/lib/supabase/browser";
import { IDLE } from "@/lib/types";
import { finishUpload, importReferenceFromUrl, startUpload } from "@/server/actions/discover";

function MetadataFields({ fe, requireTitle = false }: { fe: Record<string, string>; requireTitle?: boolean }) {
  return (
    <>
      <Field label={requireTitle ? "Title" : "Title (optional)"} name="title" error={fe.title} hint={requireTitle ? undefined : "Leave empty to use the source's title when available."}>
        <Input name="title" maxLength={200} error={fe.title} hasHint={!requireTitle} />
      </Field>
      <Field label="Description" name="description" error={fe.description}>
        <Textarea name="description" maxLength={5000} className="min-h-20" error={fe.description} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Category" name="category" error={fe.category}>
          <Select name="category" defaultValue=""><option value="">None</option>{REFERENCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>
        </Field>
        <Field label="Tags" name="tags" error={fe.tags} hint="Comma-separated, e.g. hooks, b-roll">
          <Input name="tags" maxLength={1000} error={fe.tags} hasHint />
        </Field>
      </div>
      <Field label="Personal notes" name="notes" error={fe.notes}>
        <Textarea name="notes" maxLength={10000} className="min-h-20" error={fe.notes} />
      </Field>
    </>
  );
}

export function ImportUrlForm() {
  const [state, action] = useActionState(importReferenceFromUrl, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {state.data?.existingId && <Link href={`/discover/references/${state.data.existingId}`} className="text-sm text-accent hover:text-accent-hover">Open the existing reference →</Link>}
      <Field label="Reference URL" name="url" error={fe.url} hint="Instagram Reel/post, YouTube video/Short, or any https:// link.">
        <Input name="url" type="url" required placeholder="https://www.instagram.com/reel/…" error={fe.url} hasHint />
      </Field>
      <Alert tone="info">
        Content OS checks whether the link is reachable but does not download videos from Instagram or YouTube. To analyze a reference, upload the video file on the reference page — only if you have the right to use it.
      </Alert>
      <MetadataFields fe={fe} />
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Checking link…">Save to library</SubmitButton>
      </div>
    </form>
  );
}

async function sha256Hex(file: File): Promise<string | null> {
  if (file.size > 100 * 1024 * 1024 || !globalThis.crypto?.subtle) return null; // worker verifies the real checksum anyway
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Phase = { kind: "idle" } | { kind: "working"; label: string } | { kind: "error"; message: string; existingId?: string };

/**
 * Upload flow: validate locally (type, size, magic bytes) → server reserves a
 * storage path → browser uploads directly to private storage (RLS-checked) →
 * server verifies the object exists and finalizes. Progress labels describe
 * the actual phase; no percentage is shown because none is reported.
 */
export function UploadForm({ referenceId, compact = false }: { referenceId?: string; compact?: boolean }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [fe, setFe] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<File | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const file = fileRef.current?.files?.[0];
    if (!file) return setFe({ file: "Choose a video file" });
    const check = validateUploadMeta(file);
    if (!check.ok) return setFe({ file: check.error });
    if (!sniffVideoContainer(new Uint8Array(await file.slice(0, 16).arrayBuffer()))) return setFe({ file: "This file is not a valid MP4, MOV or WebM video." });
    setFe({});

    setPhase({ kind: "working", label: "Preparing upload…" });
    const start = await startUpload({
      referenceId,
      title: String(fd.get("title") ?? ""),
      description: String(fd.get("description") ?? ""),
      category: String(fd.get("category") ?? ""),
      notes: String(fd.get("notes") ?? ""),
      tags: String(fd.get("tags") ?? ""),
      file: { name: file.name, type: check.mime, size: file.size },
    });
    if (!start.ok) {
      setFe(start.fieldErrors ?? {});
      return setPhase({ kind: "error", message: start.error });
    }
    setPhase({ kind: "working", label: `Uploading ${formatBytes(file.size)}…` });
    const { error } = await createClient().storage.from("media").upload(start.path, file, { contentType: check.mime, upsert: false });
    if (error) return setPhase({ kind: "error", message: `Upload failed: ${error.message}` });
    setPhase({ kind: "working", label: "Verifying…" });
    const done = await finishUpload(start.referenceId, await sha256Hex(file));
    if (!done.ok) return setPhase({ kind: "error", message: done.error, existingId: done.existingId });
    router.push(`/discover/references/${start.referenceId}?uploaded=1`);
    router.refresh();
  }

  const working = phase.kind === "working";
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      {phase.kind === "error" && (
        <Alert tone="danger">
          {phase.message} {phase.existingId && <Link className="underline" href={`/discover/references/${phase.existingId}`}>Open existing</Link>}
        </Alert>
      )}
      <Field label="Video file" name="file" error={fe.file} hint={`MP4, MOV or WebM · up to ${formatBytes(MAX_UPLOAD_BYTES)} · up to 10 minutes`}>
        <input
          ref={fileRef}
          id="file"
          name="file"
          type="file"
          accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
          onChange={(e) => setPicked(e.target.files?.[0] ?? null)}
          aria-invalid={fe.file ? true : undefined}
          aria-describedby={fe.file ? "file-error" : "file-hint"}
          className="block w-full rounded-md border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-fg-muted file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-fg"
        />
      </Field>
      {picked && <p className="text-xs text-fg-subtle">{picked.name} · {formatBytes(picked.size)}</p>}
      {!compact && <MetadataFields fe={fe} />}
      <p className="text-xs text-fg-subtle">Only upload videos you own or are permitted to analyze. Files are stored privately in your workspace.</p>
      <div className="flex items-center justify-end gap-3">
        {working && <span className="flex items-center gap-2 text-sm text-fg-muted" role="status"><Spinner />{phase.label}</span>}
        <Button type="submit" disabled={working}>{referenceId ? "Upload video" : "Upload and save"}</Button>
      </div>
    </form>
  );
}
