import type { TracedLogger } from './logger.js';

export type RetryOpts = {
  op: string;
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  timeoutMs: number;
  isRetryable?: ((err: unknown) => boolean) | undefined;
  logger?: TracedLogger | undefined;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 4xx (except 408/429) is terminal. 5xx, 429, 408, and generic network
 * failures are worth another attempt. Explicit AbortError is treated as
 * caller-initiated cancellation — never retry that.
 */
const defaultRetryable = (err: unknown): boolean => {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const status = (err as { status?: number }).status;
  if (typeof status === 'number') {
    if (status === 408 || status === 429) return true;
    if (status >= 500) return true;
    return false;
  }
  return true;
};

/**
 * Retry with exponential backoff + full jitter. Each attempt runs under a
 * fresh AbortController honoring `timeoutMs`, so a hung upstream does not
 * consume the entire Lambda budget. Full jitter (Amazon Builders' Library
 * recommendation) beats equal jitter for thundering-herd avoidance.
 */
export const withRetry = async <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  opts: RetryOpts,
): Promise<T> => {
  const isRetryable = opts.isRetryable ?? defaultRetryable;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= opts.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    const startedAt = Date.now();
    try {
      const result = await fn(controller.signal);
      opts.logger?.debug('retry.attempt.ok', {
        op: opts.op,
        attempt,
        latencyMs: Date.now() - startedAt,
      });
      return result;
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < opts.attempts && isRetryable(err);
      opts.logger?.warn('retry.attempt.failed', {
        op: opts.op,
        attempt,
        canRetry,
        latencyMs: Date.now() - startedAt,
        status: (err as { status?: number })?.status,
        error: err instanceof Error ? err.message : String(err),
      });
      if (!canRetry) throw err;
      const backoff = Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * backoff);
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
};
