/**
 * Message compressor — Layer 2 of token defense.
 *
 * When the total message history exceeds the compression threshold, older
 * tool-result messages get their content replaced with one-line summaries.
 * Tool call/result pairing is preserved (orphaned calls or results would
 * cause API errors at the next request).
 *
 * Operates on the framework's internal Message shape (see ../messages.ts).
 * Tool results are their own role:'tool' messages with toolCallId pointing
 * back to an assistant message's toolCalls[i].id.
 */

import type { Message, AssistantMessage, ToolResultMessage } from '../messages.js';

// ---------------------------------------------------------------------------
// Strategy interface
// ---------------------------------------------------------------------------

export interface CompressorStrategy {
  compress(messages: Message[], options: CompressionOptions): Message[];
}

export interface CompressionOptions {
  /** Number of leading messages to keep verbatim (system + initial user). */
  protectFirst: number;
  /** Number of trailing messages to keep verbatim (recent context). */
  protectLast: number;
  /** Activity-log entries used to enrich compressed summaries. Optional. */
  activityLog: Array<{ agent: string; action: string; detail?: string }>;
}

// ---------------------------------------------------------------------------
// Default: deterministic compression of old tool-result messages.
// ---------------------------------------------------------------------------

export class DeterministicCompressor implements CompressorStrategy {
  compress(messages: Message[], options: CompressionOptions): Message[] {
    const { protectFirst, protectLast } = options;
    if (messages.length <= protectFirst + protectLast) {
      return messages;
    }

    const head = messages.slice(0, protectFirst);
    const tail = messages.slice(-protectLast);
    const middle = messages.slice(protectFirst, messages.length - protectLast);

    const compressed: Message[] = [...head];
    for (const msg of middle) {
      if (msg.role === 'tool') {
        const compressedMsg: ToolResultMessage = {
          role: 'tool',
          toolCallId: msg.toolCallId,
          content: `[Previous tool result: ${msg.content.length} chars — compressed to save context]`,
        };
        compressed.push(compressedMsg);
      } else {
        compressed.push(msg);
      }
    }
    compressed.push(...tail);

    return compressed;
  }
}

// ---------------------------------------------------------------------------
// Aggressive: also compress tool-call arguments in old assistant messages.
// Used when deterministic compression isn't enough (HARD_STOP path).
// ---------------------------------------------------------------------------

export class AggressiveCompressor implements CompressorStrategy {
  compress(messages: Message[], options: CompressionOptions): Message[] {
    const { protectFirst, protectLast } = options;
    if (messages.length <= protectFirst + protectLast) {
      return messages;
    }

    const head = messages.slice(0, protectFirst);
    const tail = messages.slice(-protectLast);
    const middle = messages.slice(protectFirst, messages.length - protectLast);

    const compressed: Message[] = [...head];
    for (const msg of middle) {
      if (msg.role === 'tool') {
        compressed.push({
          role: 'tool',
          toolCallId: msg.toolCallId,
          content: '[Compressed — old tool result removed]',
        });
      } else if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
        const stubbed: AssistantMessage = {
          role: 'assistant',
          content: msg.content,
          toolCalls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: { _compressed: true, summary: `Called ${tc.name}` },
          })),
        };
        compressed.push(stubbed);
      } else {
        compressed.push(msg);
      }
    }
    compressed.push(...tail);

    return compressed;
  }
}

// ---------------------------------------------------------------------------
// Tool-pair sanitization.
//
// Ensures every assistant ToolCall has a matching tool-result message and
// vice versa. Orphaned results get dropped; orphaned calls get stub results
// inserted. Run AFTER compression and before the next API call.
//
// Partial-orphan handling: when an assistant emits multiple tool calls and
// only some have matching results, stubs for the orphaned calls are
// appended *after* the run of real tool-result messages (i.e. immediately
// before whatever non-tool message comes next, or end-of-array). This
// preserves the OpenAI invariant "every tool_call.id must have a tool
// message" without re-ordering existing real results.
// ---------------------------------------------------------------------------

export function sanitizeToolPairs(messages: Message[]): Message[] {
  const callIds = new Set<string>();
  const resultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'assistant') {
      for (const tc of msg.toolCalls) callIds.add(tc.id);
    } else if (msg.role === 'tool') {
      resultIds.add(msg.toolCallId);
    }
  }

  const orphanedCalls = new Set([...callIds].filter((id) => !resultIds.has(id)));
  const orphanedResults = new Set([...resultIds].filter((id) => !callIds.has(id)));

  if (orphanedCalls.size === 0 && orphanedResults.size === 0) {
    return messages;
  }

  const result: Message[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    // Drop orphaned tool-result messages outright.
    if (msg.role === 'tool' && orphanedResults.has(msg.toolCallId)) {
      continue;
    }

    result.push(msg);

    // Insert stub results for orphaned calls right after the assistant +
    // any contiguous run of (kept) real tool-result messages that follow
    // it. This handles the partial-orphan case where some calls have real
    // results and some don't — stubs go AFTER the real ones rather than
    // being skipped entirely (which would leave the orphans unpaired).
    if (msg.role === 'assistant') {
      const orphansHere = msg.toolCalls.map((tc) => tc.id).filter((id) => orphanedCalls.has(id));
      if (orphansHere.length === 0) continue;

      // Walk forward over any tool messages immediately following the
      // assistant — append the kept ones to result first, then stub the
      // orphans, so the final order is: assistant → real results → stubs.
      let j = i + 1;
      while (j < messages.length && messages[j]!.role === 'tool') {
        const next = messages[j]! as Extract<Message, { role: 'tool' }>;
        if (!orphanedResults.has(next.toolCallId)) {
          result.push(next);
        }
        j++;
      }

      for (const id of orphansHere) {
        result.push({
          role: 'tool',
          toolCallId: id,
          content: '[Result removed during context compression]',
        });
      }

      // Skip past the tool messages we just consumed; the outer loop's
      // `i++` lands on `j`.
      i = j - 1;
    }
  }

  return result;
}
