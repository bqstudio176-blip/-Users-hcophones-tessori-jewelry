import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { estimateCostUsd } from "../config";
import { PermanentError, RetryableError } from "../errors";
import { InvalidOutputError, RefusalError, type AnalysisModel, type ContentPart, type StructuredRequest, type StructuredResponse } from "./provider";

export const DEFAULT_ANALYSIS_MODEL = "claude-opus-5-5";

/**
 * Claude implementation using structured outputs (client.beta.messages.parse
 * + betaZodOutputFormat). Server-side refusal fallbacks are enabled by
 * default (fallbacks: "default"); set ANTHROPIC_DISABLE_FALLBACKS=1 to opt out.
 * Every response is re-validated with the Zod schema before it is returned.
 */
export class ClaudeAnalysisModel implements AnalysisModel {
  provider = "anthropic";
  private client: Anthropic;

  constructor(
    public model: string = DEFAULT_ANALYSIS_MODEL,
    opts: { apiKey?: string; client?: Anthropic; effort?: "low" | "medium" | "high"; fallbacks?: boolean } = {},
  ) {
    this.client = opts.client ?? new Anthropic(opts.apiKey ? { apiKey: opts.apiKey } : {});
    this.effort = opts.effort ?? "medium";
    this.fallbacks = opts.fallbacks ?? true;
  }
  private effort: "low" | "medium" | "high";
  private fallbacks: boolean;

  private toBlocks(content: ContentPart[]): Anthropic.Beta.Messages.BetaContentBlockParam[] {
    return content.map((p) =>
      p.type === "text"
        ? { type: "text", text: p.text }
        : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.base64 } },
    );
  }

  async generate<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResponse<z.infer<S>>> {
    const started = Date.now();
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? 16000,
        ...(this.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: this.effort, format: betaZodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: "user", content: this.toBlocks(req.content) }],
      });
    } catch (err) {
      if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
        throw new RetryableError(`Claude request failed (${err.constructor.name}): ${err.message}`.slice(0, 400));
      }
      if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
        throw new PermanentError("Claude API credentials are invalid or lack access");
      }
      if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError) {
        throw new PermanentError(`Claude rejected the request: ${err.message}`.slice(0, 400));
      }
      if (err instanceof Anthropic.APIError) throw new RetryableError(`Claude API error ${err.status}: ${err.message}`.slice(0, 400));
      throw err;
    }

    const usage = { inputTokens: response.usage?.input_tokens ?? null, outputTokens: response.usage?.output_tokens ?? null };
    const servedModel = response.model ?? this.model;
    if (response.stop_reason === "refusal") {
      throw new RefusalError(`Claude declined this request${response.stop_details?.category ? ` (${response.stop_details.category})` : ""}`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new InvalidOutputError("Claude's output was truncated (max_tokens)", usage);
    }
    const checked = req.schema.safeParse(response.parsed_output);
    if (!checked.success) {
      throw new InvalidOutputError(`Claude output failed schema validation: ${checked.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, usage);
    }
    return {
      data: checked.data,
      servedModel,
      ...usage,
      latencyMs: Date.now() - started,
      costUsd: usage.inputTokens !== null && usage.outputTokens !== null ? estimateCostUsd(servedModel, usage.inputTokens, usage.outputTokens) : null,
    };
  }
}
