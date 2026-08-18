import { describe, expect, it, vi } from 'vitest';
import { RetryExhaustedError, defaultIsRetryable, withRetry, withTimeout } from '../src/retry';

const httpError = (status: number) => Object.assign(new Error(`http ${status}`), { status });

describe('withRetry', () => {
  it('returns the first success without sleeping', async () => {
    const sleep = vi.fn(async () => {});
    const result = await withRetry(async () => 'ok', { sleep });

    expect(result).toBe('ok');
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 429 and succeeds on a later attempt', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(429);
        return 'recovered';
      },
      { sleep, random: () => 1 },
    );

    expect(result).toBe('recovered');
    expect(attempts).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 400 — it will be a 400 forever', async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;

    await expect(
      withRetry(
        async () => {
          attempts += 1;
          throw httpError(400);
        },
        { sleep },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);

    expect(attempts).toBe(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('backs off exponentially, bounded by maxDelayMs', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      withRetry(async () => { throw httpError(503); }, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 250,
        // random() === 1 makes full jitter deterministic at its ceiling.
        random: () => 1,
        sleep,
      }),
    ).rejects.toThrow();

    expect(delays).toEqual([100, 200, 250]);
  });

  it('applies full jitter rather than a fixed backoff', async () => {
    const delays: number[] = [];
    const sleep = vi.fn(async (ms: number) => {
      delays.push(ms);
    });

    await expect(
      withRetry(async () => { throw httpError(500); }, {
        maxAttempts: 3,
        baseDelayMs: 1000,
        random: () => 0.25,
        sleep,
      }),
    ).rejects.toThrow();

    // 25% of 1000, then 25% of 2000 — spread, not lockstep.
    expect(delays).toEqual([250, 500]);
  });

  it('stops early when the next wait would breach the deadline', async () => {
    const sleep = vi.fn(async () => {});

    await expect(
      withRetry(async () => { throw httpError(503); }, {
        maxAttempts: 5,
        baseDelayMs: 10_000,
        deadlineMs: 1_000,
        random: () => 1,
        sleep,
      }),
    ).rejects.toThrow();

    expect(sleep).not.toHaveBeenCalled();
  });

  it('reports the underlying error when exhausted', async () => {
    const error = await withRetry(async () => { throw httpError(500); }, {
      maxAttempts: 2,
      sleep: async () => {},
      random: () => 0,
    }).catch((e) => e as RetryExhaustedError);

    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect(error.attempts).toBe(2);
    expect(error.message).toContain('http 500');
  });
});

describe('defaultIsRetryable', () => {
  it.each([408, 409, 425, 429, 500, 502, 503, 504, 529])('retries %i', (status) => {
    expect(defaultIsRetryable(httpError(status))).toBe(true);
  });

  it.each([400, 401, 403, 404, 422])('does not retry %i', (status) => {
    expect(defaultIsRetryable(httpError(status))).toBe(false);
  });

  it('retries aborts and timeouts', () => {
    expect(defaultIsRetryable(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(true);
    expect(defaultIsRetryable(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
  });

  it('retries a bare network failure', () => {
    expect(defaultIsRetryable(new TypeError('fetch failed'))).toBe(true);
  });
});

describe('withTimeout', () => {
  it('passes through a fast result', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('rejects with a TimeoutError when the promise is slow', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 200));

    await expect(withTimeout(slow, 10, 'slow op')).rejects.toMatchObject({
      name: 'TimeoutError',
      message: expect.stringContaining('slow op'),
    });
  });
});
