# Phase 4 Proposal — Video Studio

> **Status: APPROVED on 2026-11-28 with the recommended decisions D1–D5, and IMPLEMENTED.** See IMPLEMENTATION_STATUS.md (Phase 4) for what was built and the deviations listed at the end of this document.
> No Phase 4 brief existed. The product owner asked for a scope defined from the product sequence (Discover → Analyze → Script Lab → **Video Studio** → Experiments → Publish → Analytics) and the existing architecture. Open decisions are in §11.

## 1. Goal

Turn a Script Lab script into a **ready-to-post vertical video**, assembled from footage the workspace owns. The output is a rendered MP4 (with an optional SRT) that meets Instagram Reels specs and is handed to Publish (Phase 5).

Video Studio is an **assembly** tool, built around the script's scenes. It is not a general-purpose editor, and it does not generate footage with AI.

## 2. Principles (carried over from Phases 1–3)

- **Only the user's own media.** Uploads only, and the user confirms the rights. No downloading from URLs, no stock libraries, no music catalogue.
- **No fake functionality.** Previews are labelled as approximations. Only real renders are called final. Measured facts (duration, loudness, resolution) are computed with ffprobe/ffmpeg, never guessed.
- **The database is authoritative.** RLS on every table. Multi-row writes go through `SECURITY DEFINER` RPCs. Credits are charged and refunded atomically.
- **Heavy work runs on the worker.** Renders reuse the Phase 2 Postgres job queue and the `ffmpeg.ts` wrapper (`execFile`, argument arrays, timeouts). Filter graphs are **built in code from a validated timeline**, never from user-supplied strings.
- **User edits are never overwritten.** Timelines are versioned. Each render records the timeline version it used.

## 3. Scope

### 3.1 Video projects
- Create a video from a script: an **approved** script by default, or a draft with a warning. The script version is snapshotted, so later script edits don't silently change the video. A "Script changed: update from script" action shows the diff before applying.
- Output format: 9:16 at 1080×1920 (default), 1:1 at 1080×1080, or 4:5 at 1080×1350. 30 fps.
- Status: draft → rendering → rendered → ready to publish (manual), or archived.

### 3.2 Media library
- Direct-to-storage upload, reusing the Phase 2 path-reserved pattern, of **video** (mp4/mov/webm), **image** (jpg/png/webp) and **audio** (mp3/m4a/wav). The user ticks a rights confirmation.
- The worker probes each file with ffprobe: duration, resolution, rotation, codecs, audio presence. It generates a thumbnail, and for video, a low-resolution **proxy** for smooth browser preview.
- Storage quota per plan (§11). Assets can be tagged and searched. An asset cannot be deleted while a timeline uses it.

### 3.3 Scene timeline
The timeline is one track built from the script's scenes, each with a target duration:
- **Visual:** assign a clip or image to each scene, with trim in/out on clips, a fit mode (fill-crop with an adjustable focal point, or fit with a blurred background) and Ken Burns on images (on/off).
- **Duration:** defaults to the script's estimate. With a voiceover, it can snap to the measured voiceover length.
- **Transition** to the next scene: cut (default) or a short crossfade.
- **Per-clip audio:** keep at a set volume, or mute.
- **On-screen text** comes from the script's `on_screen_text`. It is editable, uses one of 5 style presets and has 3 positions, all inside the Instagram safe zones.
- The user can reorder scenes, and duplicate or split a scene (the split creates a second visual slot).
- The UI flags any scene still missing media.

### 3.4 Voiceover
- **Record in the browser** (MediaRecorder) per scene or for the whole script, with the script text on screen as a teleprompter. Alternatively, **upload** a recording.
- The voiceover is transcribed with the existing Whisper client (word timestamps). The result is compared with the script's `spoken_text` and deviations are highlighted, which also drives caption timing.
- AI voice (TTS) is an open decision (§11, D1). If included, it sits behind a provider interface, is clearly labelled as AI-generated, and is only available when configured.

### 3.5 Captions
- **Timing:** from the voiceover's word timestamps (measured). Without a voiceover, from the scene durations, labelled "estimated timing".
- Text is editable per caption line. There are 5 caption style presets (font, size, highlight-current-word, background box) and safe-zone positioning.
- Output: **burned-in** and/or a **SRT** export.

### 3.6 Music
- The user uploads a music track (theirs, or properly licensed: rights checkbox). It can be trimmed to a start offset, faded in/out, and **ducked automatically** under the voice (ffmpeg `sidechaincompress`).

### 3.7 Preview and render
- **Live preview** in the browser plays the timeline from proxies, with HTML overlays for text and captions. It is labelled "Preview — final render may differ slightly".
- **Draft render:** 540×960, fast preset, watermark "DRAFT". Free, but rate-limited.
- **Final render:** full resolution, H.264 High, AAC 48 kHz, `+faststart`, loudness normalised to −14 LUFS. Costs credits (§11, D2), charged when queued and **refunded automatically** on failure or cancellation, as in Phase 2.
- Renders run on the worker as a new job type, with step progress (prepare → normalise clips → compose → audio mix → captions → encode → verify), heartbeat, cancellation and retry with backoff.
- The render history keeps each output, its timeline version, settings and measured stats. Downloads use short-lived signed URLs.

### 3.8 Pre-publish checks (deterministic, computed in code)
- **Duration** vs the script target, and vs the Reels limit.
- **Resolution, aspect ratio, codecs, frame rate, bitrate**, read back from the output with ffprobe.
- **Integrated loudness and true peak**, from the ffmpeg `ebur128` measurement.
- **Overlays:** any text or caption outside the safe zones.
- **Missing pieces:** scenes without media, silence over 2s while a voiceover is expected, and scripts that changed after snapshot.
- Each check is shown as pass, warn or fail. "Mark ready to publish" requires no failing checks.

### 3.9 Versions, feedback, usage
- **Timeline versions:** autosave snapshots on render, plus manual "save version" and restore, using the same pattern as script versions.
- **Feedback:** the Phase 3 widget on renders, stored with the render id.
- **Usage:** renders appear on the AI usage page (renamed "Usage"), with render minutes and credits.

## 4. Out of scope (Phase 4)

- AI-generated footage or avatars, stock media, a music catalogue.
- A free-form multi-track NLE (keyframes, effects stacks, colour grading, green screen).
- Publishing or scheduling to Instagram (Phase 5), A/B experiments (Experiments phase), analytics.
- Real-time multi-user co-editing; the last save wins, with a version conflict warning.
- Mobile-optimised editing; the editor targets desktop, with read-only views on mobile.

## 5. Data model (new migrations)

| Table | Purpose |
|---|---|
| `media_assets` | Workspace media: kind (video/image/audio), storage path, size, sha256, probe metadata, proxy and thumbnail paths, status (uploading/processing/ready/failed), `rights_confirmed_by/at`, tags |
| `video_projects` | script_id, `script_version` snapshot, format, fps, status, current timeline version, `ready_at`/`ready_by` |
| `video_timelines` | Current timeline jsonb (validated: scenes, visual refs, trims, fit, transitions, overlays, caption track, voiceover, music). Optimistic `version`. |
| `video_timeline_versions` | Append-only snapshots (source: manual/render/restore/script_update) |
| `voiceover_takes` | Asset ref, scene or whole-script scope, transcript (words with timestamps), deviation summary |
| `render_jobs` | Queue job (reusing the Phase 2 queue columns: attempts, run_after, heartbeat, cancel flag, idempotency key) plus kind (draft/final), timeline version, settings, steps, `credits_charged`/`credits_refunded` |
| `video_renders` | Output path, SRT path, measured stats (duration, resolution, codecs, bitrate, LUFS, true peak), checks jsonb, timeline version |
| plan limits | `media_storage_limits` per plan (bytes) and draft-render rate limits |

RPCs: `begin_media_upload`, `complete_media_upload`, `save_video_timeline` (optimistic version check), `restore_timeline_version`, `request_render` (idempotent, charges credits, enqueues), `cancel_render`, worker-only `claim_render_job` / `heartbeat` / `finish` / `fail` (refunding once), `mark_video_ready`.

## 6. Architecture

- **Timeline schema** (`src/server/video/timeline.ts`): Zod schema plus a validator (asset ownership, trims within the probed duration, total duration limits, safe zones).
- **Filter-graph builder** (`src/server/video/compose.ts`): a pure function from a validated timeline and probed assets to an ffmpeg argument array. It is unit-tested by snapshot and run for real against generated fixtures in tests.
- **Worker:** a render handler alongside the analysis handler, sharing claim, heartbeat and retry. A separate concurrency setting (`RENDER_CONCURRENCY`) and timeouts scaled to output length.
- **Captions** (`src/server/video/captions.ts`): line breaking, word timing from Whisper, ASS subtitle generation for burn-in, SRT export.
- **Browser:** the preview player (React, synced `<video>` elements over proxies plus overlays) and the MediaRecorder voiceover recorder.

## 7. UI screens

1. Video Studio dashboard: videos by status, "New video from script", storage usage.
2. Media library: upload, processing state, filters, asset detail.
3. Video editor: scene list and timeline, media picker, scene inspector (trim/fit/transition/text), voiceover, captions, music, live preview.
4. Voiceover recorder with teleprompter.
5. Captions editor.
6. Render panel and history, with progress, cancel and download.
7. Pre-publish checks report with "Mark ready to publish".
8. Timeline version history.
9. Entry points: "Make video" in the Script Editor; video count on the dashboard; navigation set to available.

## 8. Security

- Storage RLS by workspace path. Mime type, size and magic bytes are validated, and ffprobe must succeed before an asset is marked ready (the Phase 2 approach to fake media).
- Server-side ffmpeg arguments are built only from validated, typed values. Text overlays and captions are passed through ASS files with escaped content, never interpolated into filter strings.
- Resource limits: maximum asset size and duration, maximum output duration, a per-render wall-clock timeout, and per-workspace concurrent render limits.
- Signed URLs are short-lived. No public buckets.

## 9. Tests (planned)

- **DB:** RLS isolation for every new table; upload reservation and quota; timeline optimistic concurrency; render credit charge, refund-once and idempotency; worker-only RPCs; append-only versions; `mark_video_ready` gating.
- **Unit:** timeline validation; filter-graph builder (cases: crop/fit, image Ken Burns, crossfade, ducking, overlays); caption line breaking and timing; ASS escaping (injection attempts); checks evaluation.
- **Real ffmpeg (CI):** render generated fixture clips plus a sine-wave voiceover into a short video; assert duration, resolution, codecs and loudness within tolerance; captions burned in; cancel mid-render; retry after a forced failure.
- **Browser:** component tests for the timeline state reducer. Manual checklist for recording and preview.

## 10. Acceptance criteria (proposed)

1. Users can upload their own video, image and audio assets, which are probed, thumbnailed and proxied.
2. A video project is created from a script with its scenes pre-populated and the script version snapshotted.
3. Users can assign and trim media per scene, set fit, transition and on-screen text, and reorder scenes.
4. Users can record or upload a voiceover, which is transcribed and compared with the script.
5. Captions are timed from the voiceover (or estimated, and labelled as such), editable, burned in and exportable as SRT.
6. Music can be added with automatic ducking.
7. Draft and final renders run on the worker with progress, cancellation, retry and correct credit charge and refund.
8. Final output meets the published Reels specs, verified by ffprobe on the output.
9. Pre-publish checks run deterministically, and "ready to publish" is gated on them.
10. Timelines are versioned and restorable. Renders record their timeline version.
11. All data is workspace-isolated (RLS tests).
12. Critical tests pass, including real ffmpeg renders in CI.

## 11. Open decisions for the product owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | Include **AI voice (TTS)** in Phase 4? | **Not in Phase 4.** Recorded or uploaded voice only, which keeps the scope tight and avoids synthetic-voice disclosure issues. It can be added later behind the provider interface. |
| D2 | **Credits per final render** | 3 credits per render up to 60s, plus 1 per extra 30s. Draft renders free (10/hour per workspace). |
| D3 | **Storage quota** per plan | Free 2 GB · Creator 25 GB · Studio 150 GB. Max 1 GB and 10 min per asset. |
| D4 | **Max output duration** | 3 min. Reels publishing has its own limits, checked in §3.8. |
| D5 | Where renders run | Same worker image, as a separate job type with its own concurrency. CPU-only (no GPU). |

## 12. Dependencies and risks

- **ffmpeg on the worker** is already required by Phase 2. Rendering is CPU-heavy, so the worker's host must be sized for it (roughly real-time to 3× real-time at 1080p on 2 vCPU).
- **Whisper** (`OPENAI_API_KEY`) is needed for voiceover-timed captions. Without it, captions fall back to estimated timing.
- **Live verification:** as with Phases 2 and 3, live Supabase Storage and the live providers are not available in the build environment. Renders, however, can be fully tested for real with ffmpeg.
- Browser recording relies on MediaRecorder: Safari codec differences are handled by uploading and transcoding on the worker.

## 13. Implementation notes and deviations (added after approval)

- **One queue for all Video Studio work.** `video_jobs` (kind `asset` | `voiceover` | `render`) replaces the proposed `render_jobs`. Asset processing and transcription use the same claim, heartbeat, retry and cancel machinery as renders.
- **The current timeline lives on `video_projects.timeline`** (with an optimistic `timeline_version`) instead of a separate `video_timelines` table. History is in `video_timeline_versions`, as proposed.
- **Asset references are tracked in `video_project_assets`**, kept in sync by every save. It enforces workspace ownership and blocks deleting media a timeline still uses.
- **Usage page:** render usage and credits appear on the Video Studio dashboard and in the credit ledger (Settings → Plan & usage). The Script Lab "AI usage" page was not renamed.
- **Progress:** steps only. The encoder's percentage is not shown, because it would not be reliable.
- **Timeline versions on render:** every render snapshots the timeline (`source = render`), so a render can always be traced to an exact version.
