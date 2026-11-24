import type { z } from "zod";

export type ContentPart = { type: "text"; text: string } | { type: "image"; mediaType: "image/jpeg" | "image/png"; base64: string };

export interface StructuredRequest<S extends z.ZodType> {
  purpose: string;
  promptVersion: string;
  system: string;
  content: ContentPart[];
  schema: S;
  maxTokens?: number;
}

export interface StructuredResponse<T> {
  data: T;
  servedModel: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  costUsd: number | null;
}

/** Model-agnostic contract so the provider/model can change without touching the pipeline. */
export interface AnalysisModel {
  provider: string;
  model: string;
  generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>>;
}

export class InvalidOutputError extends Error {
  constructor(message: string, public usage?: { inputTokens: number | null; outputTokens: number | null }) {
    super(message);
    this.name = "InvalidOutputError";
  }
}

export class RefusalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefusalError";
  }
}
