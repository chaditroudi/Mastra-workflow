import { AppError } from './errors.js';
import { logger } from './logger.js';

export interface RetryOptions {
  maxAttempts?: number;
  /** Initial delay in ms before the second attempt. */
  baseDelayMs?: number;
  /** Cap on backoff between attempts. */
  maxDelayMs?: number;
  /** Predicate that overrides the default retriable check. */
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  /** Optional label for log lines. */
  label?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry an async fn with exponential backoff + full jitter.
 *
 * Default policy: retry only AppErrors flagged `retriable`. This intentionally
 * does NOT retry validation/auth/permission errors — those won't get better
 * by trying again.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 2000,
    shouldRetry = defaultShouldRetry,
    label = 'op',
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !shouldRetry(err, attempt)) {
        throw err;
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jittered = Math.floor(Math.random() * expDelay);
      logger.warn(
        { label, attempt, nextDelayMs: jittered, err: (err as Error).message },
        'retrying after transient failure',
      );
      await sleep(jittered);
    }
  }
  throw lastErr;
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof AppError) return err.retriable;
  // Network-ish errors from the driver / fetch.
  const msg = (err as Error)?.message ?? '';
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(msg);
}
