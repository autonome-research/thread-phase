/**
 * Pluggable cross-run memory.
 *
 * thread-phase ships no implementations; callers wire one in via
 * `AgentRunOptions.memoryProvider`. The interface intentionally maps to
 * the lowest common denominator across backends like Honcho, Letta, and
 * Mem0 — `recall` returns a string (the backend's distilled summary or
 * raw recall blob), and `remember` ingests an event window from the run
 * that just completed.
 *
 * @internal
 */

import type { AgentEvent } from './protocol.js';

/**
 * Scope key for a memory provider. `userId` is the partition every
 * backend expects; `appId` and `sessionId` narrow further when supported.
 *
 * @internal
 */
export interface MemoryScope {
  userId: string;
  appId?: string;
  sessionId?: string;
}

/**
 * The provider contract.
 *
 * Note: implementations are not required to provide read-your-writes
 * consistency. A `remember()` immediately followed by a `recall()` may
 * not see the new content if the backend does async indexing (Honcho's
 * derivers, for example). Callers that need strict ordering should
 * persist their own representation alongside the provider.
 *
 * @internal
 */
export interface MemoryProvider {
  recall(scope: MemoryScope, query?: string): Promise<string>;
  remember(scope: MemoryScope, events: ReadonlyArray<AgentEvent>): Promise<void>;
}
