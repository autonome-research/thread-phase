/**
 * Phase framework — the core of thread-phase.
 *
 * A pipeline is an ordered list of phases. Each phase reads typed inputs from
 * a shared `PipelineContext`, calls an agent (or pure code), writes typed
 * outputs back to the context, and yields streamed events.
 *
 * Conventions:
 * - Phases mutate `ctx` for results. Reads are advertised via `requireCtx` at
 *   the top of each phase, which throws loudly if a prerequisite phase did
 *   not run or did not populate the field.
 * - A phase sets `ctx.stop = { reason }` to halt the rest of the pipeline.
 * - Sub-flows call other phases directly: `yield* otherPhase.run(ctx)`. No
 *   DAG framework.
 *
 * Downstream apps extend `BasePipelineContext` with their own typed fields
 * and parameterize `Phase` on that context type.
 *
 * Custom event types: `Phase` has a second optional type parameter `TEvent`
 * for downstream apps that want a discriminated union of their own events
 * instead of the generic `{ type: 'data', key, value }` shape. Default is
 * the framework's `PipelineEvent`. The orchestrator and JobRunner are
 * parameterized accordingly.
 */

import type { PipelineCache } from './cache.js';

// ---------------------------------------------------------------------------
// Base context — every pipeline gets `cache` and a `stop` control signal for
// free. Downstream contexts extend this with their own typed phase outputs.
// ---------------------------------------------------------------------------

export interface BasePipelineContext {
  readonly cache: PipelineCache;
  /** Set by any phase to halt the rest of the pipeline. */
  stop?: { reason: string };
  /**
   * Optional AbortSignal observable by phases for mid-phase cancellation.
   * Populated by `runTrigger` per dispatch; `runPipeline` checks it
   * between phases as well. Phases doing long async work should pass
   * this into `runAgentWithTools({ signal })` or observe it directly.
   */
  signal?: AbortSignal;
  /**
   * Optional liveness signal. Populated by `JobRunner.run` so phases with
   * long inner loops can refresh `heartbeatAt` between iterations:
   *
   *   for (const item of items) {
   *     await processItem(item);
   *     await ctx.heartbeat?.();
   *   }
   *
   * The JobRunner's `heartbeatMs` background timer covers the common case
   * automatically; this is the manual escape hatch for tight loops that
   * might starve the event loop between ticks. Absent outside JobRunner.
   */
  heartbeat?: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Streamed event shape — what phases yield.
//
// Domain-specific events (e.g. "citation", "confidence") can be emitted via
// the generic `data` event with a string `key` for callers that don't want
// to maintain a custom union, OR a downstream app can parameterize Phase
// with its own TEvent type to get full discriminated-union narrowing.
// ---------------------------------------------------------------------------

export type PipelineEvent =
  | { type: 'phase'; phase: string; detail?: string; counts?: Record<string, number> }
  | { type: 'content'; content: string }
  | { type: 'agent_activity'; agent: string; action: string; detail?: string }
  | { type: 'tool_call'; toolName: string; toolUseId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'data'; key: string; value: unknown }
  // Emitted by the orchestrator AFTER a phase with a `checkpointKey`
  // finishes cleanly (no throw). The presence of this event in a job's
  // event log is the signal that the corresponding work can be skipped
  // on a resume. Use `completedCheckpointsFromEvents` (orchestrator.ts)
  // to derive a `Set<string>` for `RunPipelineOptions.resume`.
  | { type: 'phase_complete'; phase: string; checkpointKey: string }
  | { type: 'done'; reason?: string }
  // Terminal frame emitted by the orchestrator IMMEDIATELY before throwing
  // AbortError when ctx.signal aborts. Consumers iterating the event stream
  // (SSE bridges, audit logs) see this last; consumers awaiting the
  // generator promise still observe the AbortError rejection as before.
  | { type: 'cancelled'; reason: string }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Phase interface
//
// `TEvent` defaults to the framework's `PipelineEvent` so existing code
// stays valid. Downstream apps that want their own typed events can write:
//
//   type MyEvent = PipelineEvent | { type: 'citation'; ... };
//   const phase: Phase<MyCtx, MyEvent> = { ... };
//
// and have `MyEvent` narrowing inside `run`.
// ---------------------------------------------------------------------------

export interface Phase<
  TCtx extends BasePipelineContext = BasePipelineContext,
  TEvent = PipelineEvent,
> {
  readonly name: string;
  /**
   * Optional checkpoint marker. When set:
   *
   *   1. The orchestrator emits `{type:'phase_complete', phase, checkpointKey}`
   *      after this phase's generator exhausts cleanly.
   *   2. If `runPipeline` is invoked with `options.resume.completedKeys`
   *      containing this key, the phase is SKIPPED entirely — `run(ctx)`
   *      is not called.
   *
   * Use this for phases whose work is slow or has observable side effects
   * you don't want to repeat on a resumed run (network fetches, payments,
   * file writes). Leave it off for cheap idempotent phases — re-running
   * them on resume is harmless.
   *
   * Skips are all-or-nothing per phase. There is no partial-phase resume,
   * no rollback, no ctx restoration. The caller is responsible for
   * rehydrating ctx (cache, custom fields) from their own persisted state
   * before passing it back to runPipeline.
   */
  readonly checkpointKey?: string;
  run(ctx: TCtx): AsyncGenerator<TEvent, void>;
}

// ---------------------------------------------------------------------------
// Runtime precondition helper — fails loud on phase-reordering bugs.
// ---------------------------------------------------------------------------

export function requireCtx<TCtx extends BasePipelineContext, K extends keyof TCtx>(
  ctx: TCtx,
  key: K,
  phaseName: string,
): NonNullable<TCtx[K]> {
  const value = ctx[key];
  if (value === undefined || value === null) {
    throw new Error(
      `[${phaseName}] precondition failed: ctx.${String(key)} is not set. ` +
        `A prerequisite phase did not run or did not populate this field.`,
    );
  }
  return value as NonNullable<TCtx[K]>;
}
