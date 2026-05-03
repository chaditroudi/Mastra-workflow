import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/utils/retry.js';
import { TransientDbError, ValidationError } from '../src/utils/errors.js';

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn(async () => 42);
    const r = await withRetry(fn);
    expect(r).toBe(42);
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on retriable AppError up to maxAttempts', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      if (n < 3) throw new TransientDbError('temporary glitch');
      return 'ok';
    };
    const r = await withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });

  it('does NOT retry validation errors', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      throw new ValidationError('bad input');
    };
    await expect(withRetry(fn, { maxAttempts: 5, baseDelayMs: 1 })).rejects.toThrow(/bad input/);
    expect(n).toBe(1);
  });

  it('stops at maxAttempts and surfaces the last error', async () => {
    const fn = vi.fn(async () => {
      throw new TransientDbError('still down');
    });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(/still down/);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('honors a custom shouldRetry predicate', async () => {
    let n = 0;
    const fn = async () => {
      n++;
      throw new Error('weird');
    };
    await expect(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 1, shouldRetry: () => true }),
    ).rejects.toThrow();
    expect(n).toBe(4);
  });
});
