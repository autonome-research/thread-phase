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

  const orphanedCalls = [...callIds].filter((id) => !resultIds.has(id));
  const orphanedResults = new Set([...resultIds].filter((id) => !callIds.has(id)));

  if (orphanedCalls.length === 0 && orphanedResults.size === 0) {
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

    // Insert stub results for orphaned calls right after the assistant
    // message that contained them — but only if the next message isn't
    // already a tool-result message (in which case real results follow).
    if (msg.role === 'assistant') {
      const orphansHere = msg.toolCalls.map((tc) => tc.id).filter((id) => orphanedCalls.includes(id));
      if (orphansHere.length === 0) continue;

      const nextMsg = messages[i + 1];
      if (nextMsg?.role === 'tool') continue;

      for (const id of orphansHere) {
        result.push({
          role: 'tool',
          toolCallId: id,
          content: '[Result removed during context compression]',
        });
      }
    }
  }

  return result;
}
