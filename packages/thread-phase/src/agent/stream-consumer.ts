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

interface ToolCallBuffer {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * @internal
 *
 * Normalize OpenAI's finish_reason string into a `FinishReason` union.
 * Exported for advanced callers (e.g. building a custom streaming consumer)
 * but not part of the v1 stable surface.
 */
export function normalizeFinishReason(raw: string | null | undefined): FinishReason {
  switch (raw) {
    case 'stop':
    case 'length':
    case 'tool_calls':
    case 'content_filter':
    case 'function_call':
      return raw;
    default:
      return 'unknown';
  }
}

/**
 * @internal
 *
 * Heuristic: does this content look like a tool call that leaked through
 * as plain text? Used by the agent loop to flag a missing/wrong
 * inference-side `--tool-call-parser` configuration. Exported for callers
 * that want to apply the same heuristic; not part of the v1 stable surface.
 */
export function looksLikeToolCallText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return (
    /^<tool_call\b/i.test(trimmed) ||
    /^<function_call\b/i.test(trimmed) ||
    /^\{\s*"name"\s*:/i.test(trimmed) ||
    /^\{\s*"function"\s*:/i.test(trimmed)
  );
}

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
export async function consumeStream(
  stream: AsyncIterable<ChatCompletionChunk>,
  onContentDelta: (delta: string) => void,
): Promise<AccumulatedRound> {
  const out: AccumulatedRound = {
    content: '',
    toolCalls: [],
    finishReason: 'unknown',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
  // Tool calls stream as deltas keyed by index. Build them up by index, then
  // flatten to ToolCall[] at the end.
  const toolBuffers = new Map<number, ToolCallBuffer>();

  for await (const chunk of stream) {
    // Some backends emit an extra terminal chunk with usage and no choices.
    if (chunk.usage) {
      out.usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
      };
    }

    const choice = chunk.choices?.[0];
    if (!choice) continue;

    const delta = choice.delta as
      | {
          content?: string | null;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        }
      | undefined;

    if (delta?.content) {
      out.content += delta.content;
      onContentDelta(delta.content);
    }

    if (delta?.tool_calls) {
      for (const tcDelta of delta.tool_calls) {
        const idx = tcDelta.index;
        let buf = toolBuffers.get(idx);
        if (!buf) {
          buf = { id: '', name: '', argsBuffer: '' };
          toolBuffers.set(idx, buf);
        }
        if (tcDelta.id) buf.id = tcDelta.id;
        if (tcDelta.function?.name) buf.name = tcDelta.function.name;
        if (tcDelta.function?.arguments) buf.argsBuffer += tcDelta.function.arguments;
      }
    }

    if (choice.finish_reason) {
      out.finishReason = normalizeFinishReason(choice.finish_reason);
    }
  }

  // Flatten tool buffers in index order.
  const indices = [...toolBuffers.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const buf = toolBuffers.get(idx)!;
    if (!buf.id || !buf.name) {
      // Malformed tool call delta — skip rather than corrupt the loop.
      continue;
    }
    let input: Record<string, unknown> = {};
    try {
      input = buf.argsBuffer ? JSON.parse(buf.argsBuffer) : {};
    } catch {
      input = { _raw: buf.argsBuffer };
    }
    out.toolCalls.push({ id: buf.id, name: buf.name, input });
  }

  return out;
}
