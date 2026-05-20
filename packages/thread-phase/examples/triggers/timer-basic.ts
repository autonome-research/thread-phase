/**
 * timer-basic example — TimerTrigger + runTrigger, no persistence.
 *
 * Fires every 500ms for ~2 seconds, running a tiny pipeline each time.
 * Demonstrates the minimal substrate: a trigger source, a pipeline factory,
 * a dispatcher. No JobRunner, no JobStore, no extra infrastructure.
 *
 * Run: npx tsx examples/triggers/timer-basic.ts
 */

import {
  PipelineCache,
  type BasePipelineContext,
  type Phase,
} from '../../src/index.js';
import { TimerTrigger, runTrigger } from '../../src/triggers/index.js';

interface Ctx extends BasePipelineContext {
  tick: number;
  startedAt: string;
}

const reportTick: Phase<Ctx> = {
  name: 'report-tick',
  async *run(ctx) {
    yield {
      type: 'data',
      key: 'tick',
      value: { tick: ctx.tick, at: new Date().toISOString() },
    };
  },
};

let counter = 0;
const trigger = new TimerTrigger({
  intervalMs: 500,
  fireImmediately: true,
  name: 'every-500ms',
});

const handle = runTrigger(
  trigger,
  () => ({
    phases: [reportTick],
    ctx: {
      cache: new PipelineCache(),
      tick: ++counter,
      startedAt: new Date().toISOString(),
    },
  }),
  {
    onStart: (event) => console.log(`[start] event ${event.id} at ${event.occurredAt}`),
    onComplete: (event) => console.log(`[done]  event ${event.id}`),
  },
);

setTimeout(() => void handle.stop(), 2000);
await handle.done;
console.log(`\nProcessed ${counter} ticks.`);
