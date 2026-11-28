"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { formatBytes } from "@/lib/discover/upload";
import { ACCEPT_ATTR, MAX_ASSET_BYTES } from "@/lib/video/media-types";
import { uploadMediaFile } from "./upload";

export function MediaUploadForm() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [done, setDone] = useState(0);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!files.length) return setErrors(["Choose at least one file."]);
    if (!rights) return setErrors(["Confirm that you own these files or have the rights to use them."]);
    setErrors([]);
    setDone(0);
    const errs: string[] = [];
    for (const [i, f] of files.entries()) {
      const r = await uploadMediaFile(f, { title: f.name.replace(/\.[^.]+$/, ""), rightsConfirmed: rights, onPhase: (l) => setBusy(`${f.name} (${i + 1}/${files.length}): ${l}`) });
      if (!r.ok) errs.push(`${f.name}: ${r.error}`);
      else setDone((n) => n + 1);
    }
    setBusy(null);
    setErrors(errs);
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      {errors.length > 0 && <Alert tone="danger">{errors.map((e) => <p key={e}>{e}</p>)}</Alert>}
      {!busy && done > 0 && errors.length === 0 && <Alert tone="success">{done} file{done === 1 ? "" : "s"} uploaded. Processing runs in the background.</Alert>}
      <label htmlFor="media-files" className="block text-sm font-medium text-fg">Files</label>
      <input
        ref={fileRef}
        id="media-files"
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        onChange={(e) => setFiles([...(e.target.files ?? [])])}
        className="block w-full rounded-md border border-dashed border-line-strong bg-surface-2 p-4 text-sm text-fg-muted file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-3 file:py-1.5 file:text-fg"
        aria-describedby="media-files-hint"
      />
      <p id="media-files-hint" className="text-xs text-fg-subtle">Video (MP4, MOV, WebM), images (JPEG, PNG, WebP) or audio (MP3, M4A, WAV, WebM, Ogg) · up to {formatBytes(MAX_ASSET_BYTES)} and 10 minutes each.</p>
      {files.length > 0 && <ul className="text-xs text-fg-muted">{files.map((f) => <li key={f.name}>{f.name} · {formatBytes(f.size)}</li>)}</ul>}
      <label className="flex items-start gap-2 text-sm text-fg">
        <input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} className="mt-1 accent-[rgb(var(--color-accent))]" />
        <span>I own these files or have the rights to use them (including any music). Content OS does not provide stock media or music.</span>
      </label>
      <div className="flex items-center justify-end gap-3">
        {busy && <span className="flex items-center gap-2 text-sm text-fg-muted" role="status"><Spinner />{busy}</span>}
        <Button type="submit" disabled={Boolean(busy)}>Upload</Button>
      </div>
    </form>
  );
}
