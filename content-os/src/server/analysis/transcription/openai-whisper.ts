import { readFile, stat } from "node:fs/promises";
import { PermanentError, RetryableError } from "../errors";
import type { TranscriptionProvider, TranscriptResult } from "./types";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // provider limit

interface VerboseJson {
  language?: string;
  duration?: number;
  text?: string;
  segments?: Array<{ start: number; end: number; text: string; avg_logprob?: number; no_speech_prob?: number }>;
}

/**
 * OpenAI Whisper (`whisper-1`, response_format=verbose_json, segment
 * timestamps). Whisper does not identify speakers; confidence is derived
 * from each segment's avg_logprob (exp(avg_logprob)), labelled as derived.
 */
export class OpenAIWhisperProvider implements TranscriptionProvider {
  id = "openai";
  model = "whisper-1";
  supportsSpeakers = false;

  constructor(private apiKey: string, private fetchImpl: typeof fetch = fetch) {}

  async transcribe(audioFile: string, opts: { language?: string } = {}): Promise<TranscriptResult> {
    const size = (await stat(audioFile)).size;
    if (size > MAX_AUDIO_BYTES) throw new PermanentError("Extracted audio exceeds the transcription provider's 25 MB limit");
    const form = new FormData();
    form.set("file", new Blob([new Uint8Array(await readFile(audioFile))], { type: "audio/mpeg" }), "audio.mp3");
    form.set("model", this.model);
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (opts.language) form.set("language", opts.language);

    let res: Response;
    try {
      res = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch (err) {
      throw new RetryableError(`Transcription request failed: ${err instanceof Error ? err.message : "network error"}`);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`Transcription provider returned HTTP ${res.status}`);
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new PermanentError(`Transcription rejected: ${body.error?.message ?? `HTTP ${res.status}`}`.slice(0, 300));
    }
    const json = (await res.json()) as VerboseJson;
    return {
      provider: this.id,
      model: this.model,
      language: json.language ?? null,
      text: (json.text ?? "").trim(),
      durationSeconds: typeof json.duration === "number" ? json.duration : null,
      segments: (json.segments ?? []).map((s) => ({
        startMs: Math.max(0, Math.round(s.start * 1000)),
        endMs: Math.max(0, Math.round(s.end * 1000)),
        text: s.text.trim(),
        speaker: null,
        confidence: typeof s.avg_logprob === "number" ? Math.round(Math.min(1, Math.exp(s.avg_logprob)) * 1e5) / 1e5 : null,
      })),
    };
  }
}
