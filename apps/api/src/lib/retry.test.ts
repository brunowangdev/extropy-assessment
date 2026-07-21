import { describe, expect, it, vi } from 'vitest';
import { withRetry } from './retry.js';

const err = (status: number, message = 'boom') => {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
};

describe('withRetry', () => {
  it('retries retryable errors up to attempts', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(err(500))
      .mockRejectedValueOnce(err(500))
      .mockResolvedValueOnce('ok');
    const result = await withRetry(fn, {
      op: 'test',
      attempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 500,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx (except 408/429)', async () => {
    const fn = vi.fn().mockRejectedValue(err(400));
    await expect(
      withRetry(fn, { op: 'test', attempts: 3, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 500 }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries 429 (rate limit)', async () => {
    const fn = vi.fn().mockRejectedValueOnce(err(429)).mockResolvedValueOnce('ok');
    const result = await withRetry(fn, {
      op: 'test',
      attempts: 2,
      baseDelayMs: 1,
      maxDelayMs: 5,
      timeoutMs: 500,
    });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('gives up after `attempts` and rethrows the last error', async () => {
    const fn = vi.fn().mockRejectedValue(err(503, 'unavailable'));
    await expect(
      withRetry(fn, { op: 'test', attempts: 2, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 500 }),
    ).rejects.toThrow('unavailable');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('honors per-attempt timeout by aborting the signal', async () => {
    const fn = vi.fn(
      (signal: AbortSignal) =>
        new Promise((_, rej) => {
          signal.addEventListener('abort', () =>
            rej(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        }),
    );
    await expect(
      withRetry(fn, { op: 'test', attempts: 1, baseDelayMs: 1, maxDelayMs: 5, timeoutMs: 10 }),
    ).rejects.toThrow('aborted');
  });
});
