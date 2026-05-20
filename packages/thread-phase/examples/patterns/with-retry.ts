/**
 * withRetry example — retrying a flaky phase.
 *
 * Wraps a simulated network-call phase that fails on the first two attempts
 * and succeeds on the third. Exponential backoff with a small base delay
 * keeps the example fast.
 *
 * Run: npx tsx examples/patterns/with-retry.ts
 */

import {
  PipelineCache,
  runPipeline,
  type Phase,
  type BasePipelineContext,
} from '../../src/index.js';
import { withRetry } from '../../src/patterns/index.js';

interface Ctx extends BasePipelineContext {
  attempts: number;
  payload?: string;
}

let serverFailCount = 0;

const flakyFetch: Phase<Ctx> = {
  name: 'flaky-fetch',
  async *run(ctx) {
    ctx.attempts++;
    yield { type: 'phase', phase: 'flaky-fetch', detail: `attempt ${ctx.attempts}` };

    serverFailCount++;
    if (serverFailCount < 3) {
      throw new Error(`server returned 503 (call ${serverFailCount})`);
    }

    ctx.payload = `OK on call ${serverFailCount}`;
    yield { type: 'data', key: 'payload', value: ctx.payload };
  },
};

const ctx: Ctx = {
  cache: new PipelineCache(),
  attempts: 0,
};

const phases: Phase<Ctx>[] = [
  withRetry(flakyFetch, {
    maxAttempts: 5,
    baseDelayMs: 50,
    onRetry: (_ctx, attempt, err) => {
      console.log(
        `[retry] attempt ${attempt} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    },
  }),
];

for await (const event of runPipeline(phases, ctx)) {
  console.log(JSON.stringify(event));
}

console.log('\nResult:', ctx.payload, 'after', ctx.attempts, 'attempts');
