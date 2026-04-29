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
}

// ---------------------------------------------------------------------------
// Streamed event shape — what phases yield.
//
// Domain-specific events (e.g. "citation", "confidence") are emitted via the
// generic `data` event with a string `key`, so the framework's union doesn't
// need to know about every downstream event type.
// ---------------------------------------------------------------------------

export type PipelineEvent =
  | { type: 'phase'; phase: string; detail?: string; counts?: Record<string, number> }
  | { type: 'content'; content: string }
  | { type: 'agent_activity'; agent: string; action: string; detail?: string }
  | { type: 'tool_call'; toolName: string; toolUseId: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolUseId: string; content: string }
  | { type: 'data'; key: string; value: unknown }
  | { type: 'done'; reason?: string }
  | { type: 'error'; message: string };

// ---------------------------------------------------------------------------
// Phase interface
// ---------------------------------------------------------------------------

export interface Phase<TCtx extends BasePipelineContext = BasePipelineContext> {
  readonly name: string;
  run(ctx: TCtx): AsyncGenerator<PipelineEvent, void>;
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
