/**
 * Retry with exponential backoff, full jitter, and a hard wall-clock deadline.
 *
 * Two rules worth stating out loud, because getting either wrong is how a
 * retry policy turns a blip into an outage:
 *
 *   1. Only retry what is actually retryable. A 400 will be a 400 forever;
 *      retrying it burns budget and delays the error the caller needs to see.
 *   2. Jitter is not optional. Without it, every worker that failed during the
 *      same incident retries in lockstep and re-creates the thundering herd.
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Wall-clock ceiling across all attempts, including waits. */
  deadlineMs?: number;
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export class RetryExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(
      `retry exhausted after ${attempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`,
    );
    this.name = 'RetryExhaustedError';
  }
}

/** Status codes worth trying again: transient by definition. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

export function defaultIsRetryable(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return RETRYABLE_STATUS.has(status);

    const name = (error as { name?: unknown }).name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
  }
  // A bare network failure has no status. Assume transient.
  return error instanceof TypeError;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 500,
    maxDelayMs = 15_000,
    deadlineMs = 120_000,
    isRetryable = defaultIsRetryable,
    onRetry,
    sleep = defaultSleep,
    random = Math.random,
  } = options;

  const startedAt = Date.now();
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;

      if (attempt === maxAttempts || !isRetryable(error)) break;

      // Full jitter: uniform in [0, backoff]. Beats "backoff ± 10%" for
      // spreading a synchronised herd.
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delay = Math.floor(random() * backoff);

      if (Date.now() - startedAt + delay > deadlineMs) break;

      onRetry?.(attempt, delay, error);
      await sleep(delay);
    }
  }

  throw new RetryExhaustedError(maxAttempts, lastError);
}

/** Reject if `promise` has not settled within `ms`. */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${label} timed out after ${ms}ms`);
          error.name = 'TimeoutError';
          reject(error);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
