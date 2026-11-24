/** Errors that must not be retried (bad input, unsupported media, misconfiguration). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentError";
  }
}

/** Transient errors (rate limits, provider 5xx, network). The queue retries these with backoff. */
export class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

export class CanceledError extends Error {
  constructor() {
    super("Canceled by user");
    this.name = "CanceledError";
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof PermanentError || err instanceof CanceledError) return false;
  return true; // unknown errors get the benefit of the doubt (bounded by max_attempts)
}
