export interface TranscriptSegment {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string | null;
  /** Provider-reported or derived confidence (0–1); null when not available. */
  confidence: number | null;
}

export interface TranscriptResult {
  provider: string;
  model: string;
  language: string | null;
  text: string;
  durationSeconds: number | null;
  segments: TranscriptSegment[];
}

export interface TranscriptionProvider {
  id: string;
  model: string;
  /** Whether segments include speaker labels. */
  supportsSpeakers: boolean;
  transcribe(audioFile: string, opts?: { language?: string }): Promise<TranscriptResult>;
}
