/**
 * Agent runner — the tool-use loop primitive.
 *
 * Given an agent config (system prompt, tools, model tier), a starting
 * conversation, and an executor for the tools, runs an iterated tool-use
 * loop against an OpenAI-compatible inference endpoint until the agent
 * produces final text or hits its round budget.
 *
 * Composed from focused helpers in this directory:
 *   - `./types.ts`           — public surface
 *   - `./openai-adapter.ts`  — Message↔OpenAI wire-format translation
 *   - `./stream-consumer.ts` — folds streaming chunks into one round's state
 *   - `./retry.ts`           — error classification (retryable, abort)
 *
 * What the loop owns:
 *   - Round budgeting and the compress / hard-stop transitions
 *   - Streaming the request, dispatching tools, collecting results
 *   - Cumulative usage / executedToolCalls accounting across rounds
 *   - Cancellation observation (AbortSignal in options)
 *   - The verifyResult hook, the parser-mismatch warning, the retry loop
 */
import type { Message } from '../messages.js';
import type { AgentConfig, AgentRunnerOptions, AgentRunResult } from './types.js';
export declare function runAgentWithTools(config: AgentConfig, initialMessages: Message[], options: AgentRunnerOptions, agentLabel?: string): Promise<AgentRunResult>;
//# sourceMappingURL=runner.d.ts.map