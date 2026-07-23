/**
 * Thread — the conversational object that flows through pipeline phases.
 *
 * The canonical `AgentEvent` log is the source of truth; `resumeTokens`
 * point at adapter-native continuation state held externally by each
 * adapter (session files on disk, response ids in a vendor's store). When
 * the next phase happens to use the same adapter, it passes the matching
 * resume token and continues natively. When the next phase is a different
 * adapter, it renders the canonical events into a permissive message log
 * via `threadToMessages` and starts a fresh session.
 *
 */
import type { AgentEvent, ResumeToken } from './protocol.js';
import type { Message } from '../messages.js';
/**
 * Conversational state across phases.
 *
 * - `events`: append-only canonical log. Survives cross-adapter handoffs.
 * - `resumeTokens`: per-adapter (keyed by `AgentAdapterMeta.id`) pointers
 *   to adapter-native state. Adapters set their own token, never another
 *   adapter's.
 *
 */
export interface Thread {
    events: AgentEvent[];
    resumeTokens: Record<string, ResumeToken>;
}
export declare function createThread(): Thread;
export declare function appendEvent(thread: Thread, event: AgentEvent): void;
export declare function resumeTokenFor(thread: Thread, adapterId: string): ResumeToken | undefined;
export declare function setResumeToken(thread: Thread, adapterId: string, token: ResumeToken): void;
/**
 * Render canonical events into thread-phase's internal `Message[]` for
 * cross-adapter handoff when no per-adapter resume token is available.
 *
 * Lossy by design:
 * - `native` events are skipped — they have no canonical message equivalent.
 * - `tool_result.output` is coerced to a string. Adapters that need the
 *   native shape should consume the canonical event log directly.
 * - `error` and `agent_start`/`agent_end` events do not produce messages;
 *   they are run-lifecycle signals, not conversation content.
 * - Multiple assistant turns within one run become one assistant message
 *   per turn boundary (`turn_end`); a trailing text run without a
 *   `turn_end` is flushed at `agent_end`.
 *
 * Treat the output as conversation history, not as an authoritative log.
 *
 */
export declare function threadToMessages(thread: Thread): Message[];
//# sourceMappingURL=thread.d.ts.map