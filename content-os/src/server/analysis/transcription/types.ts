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
  /** Word-level timestamps, present only when requested and supported. */
  words?: { startMs: number; endMs: number; text: string }[];
}

export interface TranscriptionProvider {
  id: string;
  model: string;
  /** Whether segments include speaker labels. */
  supportsSpeakers: boolean;
  transcribe(audioFile: string, opts?: { language?: string; wordTimestamps?: boolean }): Promise<TranscriptResult>;
}
