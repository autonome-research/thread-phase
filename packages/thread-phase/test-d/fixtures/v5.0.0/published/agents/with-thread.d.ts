/**
 * Decorate an `AgentAdapter` with automatic `Thread` wiring:
 *
 *   1. Reads `thread.resumeTokens[meta.id]` and splices it into the
 *      inner config via the `applyResume` callback. Adapters whose
 *      resumption field name differs (anthropic has none, codex uses
 *      `previousResponseId`, ACP-based uses `resumeSessionId`, etc.)
 *      provide their own splice.
 *   2. Tees every event into `thread.events`. The thread becomes a
 *      durable log of the conversation that flows between phases.
 *   3. When a fresh `resumeToken` appears on `agent_start` or `agent_end`,
 *      writes it back to `thread.resumeTokens[meta.id]` so subsequent
 *      calls with the same thread auto-resume.
 *
 * Unlike `withMemory`, the thread is passed explicitly to the wrapper
 * factory — `Thread` is a per-pipeline primitive, `MemoryProvider` is
 * a cross-pipeline backend. Thread mutation happens through the same
 * `appendEvent` / `setResumeToken` helpers callers would use manually.
 *
 */
import type { AgentAdapterMeta, ResumeToken } from './protocol.js';
import { type Thread } from './thread.js';
export interface WithThreadOptions<TConfig> {
    /**
     * Splice the thread's per-adapter resume token into the inner config.
     * Called only when `thread.resumeTokens[meta.id]` is present. Adapters
     * without resumption (anthropicAgent) omit this — the wrapper still
     * mirrors events into the thread, just doesn't try to inject a resume.
     */
    applyResume?: (config: TConfig, resumeToken: ResumeToken) => TConfig;
}
/**
 * Wrap an adapter so every invocation reads/writes a shared `Thread`.
 * Events get appended; new resume tokens get persisted; existing tokens
 * get spliced into the next run's config.
 *
 * Mutation is in-place on the supplied thread. The wrapper does not
 * defensively clone — caller controls the thread's lifetime.
 *
 */
export declare function withThread<TConfig>(meta: AgentAdapterMeta<TConfig>, thread: Thread, opts?: WithThreadOptions<TConfig>): AgentAdapterMeta<TConfig>;
//# sourceMappingURL=with-thread.d.ts.map