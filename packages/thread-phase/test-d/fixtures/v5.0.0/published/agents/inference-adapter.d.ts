/**
 * `inferenceAgent` — the in-tree reference `AgentAdapter`.
 *
 * Wraps `runAgentWithTools` (the OpenAI-compatible inference loop) behind
 * the canonical adapter protocol so the loop becomes one valid adapter
 * alongside future sibling adapters (pi, Claude Code, OpenAI Agents SDK).
 *
 * Declared capabilities:
 *   - streaming:        'text'         (content deltas only)
 *   - cancellation:     'cooperative'  (honors `options.signal` and `abort()`)
 *   - resumption:       'none'
 *   - structuredOutput: 'prompted'     (uses ./structured-output.ts)
 *
 * The run starts lazily: the underlying `runAgentWithTools` is invoked
 * when either `events` is iterated or `result` is awaited, whichever comes
 * first. Translation rules from runner stream events → canonical
 * `AgentEvent`s are documented inline on the `onStreamEvent` callback.
 *
 */
import { type AgentConfig, type AgentRunnerOptions } from '../agent/index.js';
import type { Message } from '../messages.js';
import { type AgentAdapterMeta, type AgentEventBus } from './protocol.js';
import { type StructuredOutputConfig } from './structured-output.js';
/**
 * Configuration for the in-tree inference adapter. Wraps the same inputs
 * `runAgentWithTools` already takes plus an optional structured-output spec.
 *
 */
export interface InferenceAgentConfig {
    /** Agent config passed to `runAgentWithTools`. */
    config: AgentConfig;
    /** Initial messages. The adapter prepends/appends none on top. */
    messages: Message[];
    /**
     * Runner options (client, toolExecutor, cache, etc.). The adapter wires
     * `signal` and `onStreamEvent` itself; pre-existing fields on this object
     * are forwarded unchanged.
     */
    runnerOptions: Omit<AgentRunnerOptions, 'signal' | 'onStreamEvent'>;
    /** Optional structured-output spec (prompted path). */
    outputSchema?: StructuredOutputConfig;
}
/**
 * The adapter metadata, suitable for registration alongside future siblings.
 *
 */
export declare const inferenceAgent: AgentAdapterMeta<InferenceAgentConfig>;
export type { AgentEventBus };
//# sourceMappingURL=inference-adapter.d.ts.map