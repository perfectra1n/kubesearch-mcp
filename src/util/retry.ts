/** Bounded retry with exponential backoff for transient network failures. */

export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

/** 5xx, 429 and 408 are worth retrying; other HTTP statuses are not. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

export interface RetryOptions {
  /** Total attempts including the first one. */
  attempts?: number;
  /** Delay before the first retry; each subsequent retry multiplies by `factor`. */
  baseMs?: number;
  factor?: number;
  jitter?: boolean;
  /** Return false to fail immediately (e.g. 403/404). Defaults to retrying everything. */
  retryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number) => void;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 4;
  const jitter = opts.jitter ?? true;
  const retryable = opts.retryable ?? (() => true);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !retryable(err)) throw err;
      opts.onRetry?.(err, attempt);
      const delay = baseMs * factor ** (attempt - 1);
      await sleep(jitter ? delay * (0.5 + Math.random() / 2) : delay);
    }
  }
  throw lastErr;
}
