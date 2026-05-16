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
export class TurnAccumulator {
  private turnText = '';
  private pending: { text: string; toolCallCount: number; usage?: UsageInfo } | null = null;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly source: string,
    private readonly traceId?: string,
  ) {}

  /**
   * Emit a text delta. Flushes any pending `turn_end` first — a text delta
   * after `markTurnEnd()` is the canonical signal that a new turn has begun.
   */
  text(delta: string): void {
    if (this.pending) this.flush();
    this.turnText += delta;
    this.emit({ type: 'text', source: this.source, traceId: this.traceId, delta });
  }

  /**
   * Emit a thinking (reasoning) delta. Does NOT flush a pending turn —
   * reasoning is intra-turn content, not a turn boundary signal.
   */
  thinking(delta: string): void {
    this.emit({ type: 'thinking', source: this.source, traceId: this.traceId, delta });
  }

  /**
   * Emit a tool call. Increments the pending turn's `toolCallCount` if a
   * `markTurnEnd()` has been seen since the last flush.
   */
  toolCall(id: string, name: string, input: unknown): void {
    if (this.pending) this.pending.toolCallCount += 1;
    this.emit({ type: 'tool_call', source: this.source, traceId: this.traceId, id, name, input });
  }

  /** Emit a tool result. Does not affect pending-turn state. */
  toolResult(id: string, name: string, output: unknown, isError: boolean): void {
    this.emit({
      type: 'tool_result',
      source: this.source,
      traceId: this.traceId,
      id,
      name,
      output,
      isError,
    });
  }

  /**
   * Emit a native (adapter-specific) event verbatim. Stamps `source` and
   * `traceId` so adapters don't have to repeat the boilerplate. Does not
   * affect pending-turn state.
   */
  native(kind: string, payload: unknown): void {
    this.emit({ type: 'native', source: this.source, traceId: this.traceId, kind, payload });
  }

  /**
   * Mark the end of a turn. Captures the accumulated assistant text and
   * arms a pending `turn_end`. The event is NOT emitted yet — tool calls
   * that arrive between now and the next text delta (or `close()`)
   * accumulate into the pending entry's `toolCallCount`.
   *
   * Optional `usage` is attached to the eventual `turn_end` event.
   */
  markTurnEnd(usage?: UsageInfo): void {
    this.pending = { text: this.turnText, toolCallCount: 0, usage };
    this.turnText = '';
  }

  /**
   * Flush any pending `turn_end`. Call once at run end, before emitting
   * `agent_end`. Idempotent — calling twice with nothing pending is a no-op.
   */
  close(): void {
    this.flush();
  }

  private flush(): void {
    if (!this.pending) return;
    this.emit({
      type: 'turn_end',
      source: this.source,
      traceId: this.traceId,
      assistantText: this.pending.text,
      usage: this.pending.usage,
      toolCallCount: this.pending.toolCallCount,
    });
    this.pending = null;
  }
}
