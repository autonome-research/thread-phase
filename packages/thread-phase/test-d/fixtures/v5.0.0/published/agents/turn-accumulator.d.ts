/**
 * Helper for translating primitive adapter-level callbacks into canonical
 * `AgentEvent`s with correct turn-boundary semantics.
 *
 * The non-obvious problem this solves: some underlying runtimes (the in-tree
 * OpenAI runner is one) emit their end-of-turn marker BEFORE the tool calls
 * of that turn — the model decodes content, the runtime fires `round_complete`,
 * then the tool calls follow as separate events. In canonical semantics, a
 * `turn_end` belongs AFTER its turn's tool calls so `toolCallCount` reflects
 * what actually happened in that turn.
 *
 * The accumulator handles this by deferring `turn_end` emission. Call
 * `markTurnEnd()` when the underlying runtime says the turn ended; the event
 * is held until the NEXT text delta (= new turn starts) or `close()` (= run
 * ends). Tool calls in between count against the pending turn.
 *
 * Adapters whose runtime emits turn boundaries naturally (after all tool
 * calls of the same turn) can still use this helper — `markTurnEnd()` +
 * `close()` with no intervening events flushes immediately.
 *
 * Also handles the boilerplate of stamping `source` and `traceId` on every
 * canonical event the adapter emits, which every adapter has to do.
 *
 * @internal
 */
import type { UsageInfo } from '../agent/types.js';
import type { AgentEvent } from './protocol.js';
/** @internal */
export declare class TurnAccumulator {
    private readonly emit;
    private readonly source;
    private readonly traceId?;
    private turnText;
    private currentTurnToolCalls;
    private pending;
    constructor(emit: (event: AgentEvent) => void, source: string, traceId?: string | undefined);
    /**
     * Emit a text delta. Flushes any pending `turn_end` first — a text delta
     * after `markTurnEnd()` is the canonical signal that a new turn has begun.
     */
    text(delta: string): void;
    /**
     * Emit a thinking (reasoning) delta. Does NOT flush a pending turn —
     * reasoning is intra-turn content, not a turn boundary signal.
     */
    thinking(delta: string): void;
    /**
     * Emit a tool call. Counts toward the current turn regardless of which
     * turn-end style the adapter uses — deferred (`markTurnEnd`) or
     * immediate (`endTurn`).
     */
    toolCall(id: string, name: string, input: unknown): void;
    /** Emit a tool result. Does not affect pending-turn state. */
    toolResult(id: string, name: string, output: unknown, isError: boolean): void;
    /**
     * Emit a native (adapter-specific) event verbatim. Stamps `source` and
     * `traceId` so adapters don't have to repeat the boilerplate. Does not
     * affect pending-turn state.
     */
    native(kind: string, payload: unknown): void;
    /**
     * Mark the end of a turn — deferred-emission variant. Use when the
     * underlying runtime emits its end-of-turn marker BEFORE the tool calls
     * that belong to that turn (the in-tree OpenAI runner is one such case).
     * The `turn_end` event is NOT emitted yet; it stays pending until either
     * the next text delta (next turn starts) or `close()` (run ends). Tool
     * calls that arrive between now and the flush count toward this turn.
     *
     * For runtimes with natural turn ordering (tool calls inside the turn,
     * then turn boundary), use `endTurn()` instead.
     *
     * Optional `usage` is attached to the eventual `turn_end` event.
     */
    markTurnEnd(usage?: UsageInfo): void;
    /**
     * Emit a `turn_end` event NOW with the current turn's text and tool-call
     * count, then reset the counters. Use when the underlying runtime
     * already had all of this turn's tool calls before the boundary signal
     * (the ACP `session/prompt` response is one such case — agent_message_chunks
     * and tool_calls precede the stopReason).
     *
     * If a `markTurnEnd()` deferred turn is still pending, it's flushed first.
     *
     * Optional `usage` is attached to the emitted `turn_end` event.
     */
    endTurn(usage?: UsageInfo): void;
    /**
     * Flush any pending `turn_end`. Call once at run end, before emitting
     * `agent_end`. Idempotent — calling twice with nothing pending is a no-op.
     */
    close(): void;
    private flush;
}
//# sourceMappingURL=turn-accumulator.d.ts.map