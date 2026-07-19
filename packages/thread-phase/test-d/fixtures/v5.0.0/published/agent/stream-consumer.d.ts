/**
 * Stream consumer — folds an OpenAI streaming chat-completion response into
 * a single round's accumulated state (content, tool_calls, finish_reason,
 * usage). Tool calls arrive as per-index deltas; we buffer by index and
 * JSON-parse the args at the end.
 *
 * Pure data transform: takes an AsyncIterable of chunks, calls the supplied
 * callback for each content delta, returns the assembled AccumulatedRound.
 * No I/O, no logging, no agent state — keeps the consumer testable in
 * isolation.
 */
import type { ChatCompletionChunk } from 'openai/resources/chat/completions.js';
import type { ToolCall } from '../messages.js';
import type { FinishReason, UsageInfo } from './types.js';
/**
 * @internal
 *
 * Internal accumulator shape — not part of the public API. May change
 * between minor versions.
 */
export interface AccumulatedRound {
    content: string;
    toolCalls: ToolCall[];
    finishReason: FinishReason;
    usage: UsageInfo;
}
/**
 * @internal
 *
 * Normalize OpenAI's finish_reason string into a `FinishReason` union.
 * Exported for advanced callers (e.g. building a custom streaming consumer)
 * but not part of the v1 stable surface.
 */
export declare function normalizeFinishReason(raw: string | null | undefined): FinishReason;
/**
 * @internal
 *
 * Heuristic: does this content look like a tool call that leaked through
 * as plain text? Used by the agent loop to flag a missing/wrong
 * inference-side `--tool-call-parser` configuration. Exported for callers
 * that want to apply the same heuristic; not part of the v1 stable surface.
 */
export declare function looksLikeToolCallText(text: string): boolean;
/**
 * @internal
 *
 * Consume one streaming chat-completion response.
 *
 * Calls `onContentDelta` synchronously for each chunk's content fragment so
 * the caller can surface them upstream as they arrive. Returns the assembled
 * round once the stream ends.
 *
 * Exported for advanced callers (e.g. building a non-loop agent that just
 * streams once and returns); not part of the v1 stable surface.
 */
export declare function consumeStream(stream: AsyncIterable<ChatCompletionChunk>, onContentDelta: (delta: string) => void): Promise<AccumulatedRound>;
//# sourceMappingURL=stream-consumer.d.ts.map