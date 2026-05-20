/**
 * withRetry — higher-order phase wrapper.
 */

import { describe, it, expect, vi } from 'vitest';
import { withRetry } from '../src/patterns/with-retry.js';
import { PipelineCache } from '../src/cache.js';
import type {
  BasePipelineContext,
  Phase,
  PipelineEvent,
} from '../src/phase.js';

interface Ctx extends BasePipelineContext {
  attempts?: number;
  log?: string[];
}

const makeCtx = (): Ctx => ({
  cache: new PipelineCache(),
  attempts: 0,
  log: [],
});

describe('withRetry', () => {
  it('succeeds on first attempt with no retries', async () => {
    const inner: Phase<Ctx> = {
      name: 'inner',
      async *run(ctx) {
        ctx.attempts = (ctx.attempts ?? 0) + 1;
        yield { type: 'phase', phase: 'inner' };
      },
    };
    const wrapped = withRetry(inner, { baseDelayMs: 1 });

    const ctx = makeCtx();
    const events: PipelineEvent[] = [];
    for await (const ev of wrapped.run(ctx)) events.push(ev);

    expect(ctx.attempts).toBe(1);
    const attempts = events.filter(
      (e) => e.type === 'data' && e.key === 'inner.attempt',
    );
    expect(attempts).toHaveLength(1);
  });

  it('retries on thrown error and eventually succeeds', async () => {
    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        ctx.attempts = (ctx.attempts ?? 0) + 1;
        n++;
        if (n < 3) throw new Error(`fail ${n}`);
        yield { type: 'phase', phase: 'flaky' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 5, baseDelayMs: 1 });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(ctx.attempts).toBe(3);
    expect(ctx.stop).toBeUndefined();
  });

  it('retries on ctx.stop and eventually succeeds', async () => {
    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        ctx.attempts = (ctx.attempts ?? 0) + 1;
        n++;
        if (n < 2) {
          ctx.stop = { reason: `attempt ${n} failed` };
          yield { type: 'phase', phase: 'flaky', detail: 'failed' };
          return;
        }
        yield { type: 'phase', phase: 'flaky', detail: 'ok' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 3, baseDelayMs: 1 });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(ctx.attempts).toBe(2);
    expect(ctx.stop).toBeUndefined();
  });

  it('exhausts attempts and rethrows the last error', async () => {
    const inner: Phase<Ctx> = {
      name: 'doomed',
      async *run(ctx) {
        ctx.attempts = (ctx.attempts ?? 0) + 1;
        throw new Error(`fail ${ctx.attempts}`);
        yield { type: 'phase', phase: 'doomed' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 3, baseDelayMs: 1 });

    const ctx = makeCtx();
    const consume = async () => {
      for await (const _ of wrapped.run(ctx)) {
        // drain
      }
    };

    await expect(consume()).rejects.toThrow('fail 3');
    expect(ctx.attempts).toBe(3);
  });

  it('exhausts attempts and leaves ctx.stop set when the inner used ctx.stop', async () => {
    const inner: Phase<Ctx> = {
      name: 'doomed',
      async *run(ctx) {
        ctx.attempts = (ctx.attempts ?? 0) + 1;
        ctx.stop = { reason: `attempt ${ctx.attempts} failed` };
        yield { type: 'phase', phase: 'doomed' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 3, baseDelayMs: 1 });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(ctx.attempts).toBe(3);
    expect(ctx.stop).toEqual({ reason: 'attempt 3 failed' });
  });

  it('invokes onRetry between attempts but not before the first', async () => {
    const onRetry = vi.fn();
    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        n++;
        if (n < 3) throw new Error('boom');
        yield { type: 'phase', phase: 'flaky' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 5, baseDelayMs: 1, onRetry });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, ctx, 1, expect.any(Error));
    expect(onRetry).toHaveBeenNthCalledWith(2, ctx, 2, expect.any(Error));
  });

  it('invokes resetState between attempts', async () => {
    const resetState = vi.fn((ctx: Ctx) => {
      ctx.log = [];
    });

    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        ctx.log?.push(`attempt-${++n}`);
        if (n < 2) throw new Error('boom');
        yield { type: 'phase', phase: 'flaky' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 3, baseDelayMs: 1, resetState });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(resetState).toHaveBeenCalledTimes(1);
    expect(ctx.log).toEqual(['attempt-2']);
  });

  it('isFailure can mark ctx.stop as success', async () => {
    const inner: Phase<Ctx> = {
      name: 'cancel-aware',
      async *run(ctx) {
        ctx.stop = { reason: 'user-cancelled' };
        yield { type: 'phase', phase: 'cancel-aware' };
      },
    };
    const wrapped = withRetry(inner, {
      maxAttempts: 3,
      baseDelayMs: 1,
      isFailure: (ctx) => ctx.stop?.reason !== 'user-cancelled',
    });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(ctx.stop).toEqual({ reason: 'user-cancelled' });
  });

  it('preserves phase name on the wrapper', () => {
    const inner: Phase<Ctx> = {
      name: 'original',
      async *run() {
        yield { type: 'phase', phase: 'original' };
      },
    };
    const wrapped = withRetry(inner);
    expect(wrapped.name).toBe('original');
  });

  it('applies exponential backoff between attempts', async () => {
    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run() {
        n++;
        if (n < 3) throw new Error('boom');
        yield { type: 'phase', phase: 'flaky' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 5, baseDelayMs: 20 });

    const ctx = makeCtx();
    const start = Date.now();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }
    const elapsed = Date.now() - start;

    // After 2 retries: ~20ms + ~40ms = ~60ms minimum.
    expect(elapsed).toBeGreaterThanOrEqual(50);
    expect(n).toBe(3);
  });

  it('clears prior ctx.stop before each inner run', async () => {
    let n = 0;
    const inner: Phase<Ctx> = {
      name: 'flaky',
      async *run(ctx) {
        n++;
        // First two attempts, observe stop is undefined; set it; fail.
        expect(ctx.stop).toBeUndefined();
        if (n < 3) {
          ctx.stop = { reason: `attempt ${n}` };
          yield { type: 'phase', phase: 'flaky' };
          return;
        }
        yield { type: 'phase', phase: 'flaky' };
      },
    };
    const wrapped = withRetry(inner, { maxAttempts: 5, baseDelayMs: 1 });

    const ctx = makeCtx();
    for await (const _ of wrapped.run(ctx)) {
      // drain
    }

    expect(n).toBe(3);
    expect(ctx.stop).toBeUndefined();
  });
});
