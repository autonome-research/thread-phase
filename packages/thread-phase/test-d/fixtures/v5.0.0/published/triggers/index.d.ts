/**
 * Triggers — entry-point abstraction for thread-phase pipelines.
 *
 * The `Trigger` interface is the protocol every signal source implements:
 * timers, webhooks, queue consumers, file watchers, message brokers.
 * Core ships only `TimerTrigger`; HTTP/queue/file-watch adapters live in
 * `examples/triggers/` as recipes.
 *
 * `runTrigger` is the canonical consumer — reads events, dispatches
 * pipelines, optionally persists through a `JobRunner`.
 */
export type { Trigger, TriggerEvent } from './types.js';
export { TimerTrigger, type TimerTriggerOptions } from './timer-trigger.js';
export { runTrigger, type RunTriggerOptions, type RunTriggerHandle, } from './run-trigger.js';
//# sourceMappingURL=index.d.ts.map