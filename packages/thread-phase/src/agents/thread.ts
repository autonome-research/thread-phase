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
import type { Message, ToolCall } from '../messages.js';

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
export function createThread(): Thread {
  return { events: [], resumeTokens: {} };
}
export function appendEvent(thread: Thread, event: AgentEvent): void {
  thread.events.push(event);
}
export function resumeTokenFor(thread: Thread, adapterId: string): ResumeToken | undefined {
  return thread.resumeTokens[adapterId];
}
export function setResumeToken(thread: Thread, adapterId: string, token: ResumeToken): void {
  thread.resumeTokens[adapterId] = token;
}

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
export function threadToMessages(thread: Thread): Message[] {
  const out: Message[] = [];

  let pendingText = '';
  let pendingToolCalls: ToolCall[] = [];
  let hasAssistantContent = false;

  const flushAssistant = (): void => {
    if (!hasAssistantContent) return;
    out.push({
      role: 'assistant',
      content: pendingText,
      toolCalls: pendingToolCalls,
    });
    pendingText = '';
    pendingToolCalls = [];
    hasAssistantContent = false;
  };

  for (const event of thread.events) {
    switch (event.type) {
      case 'text':
        pendingText += event.delta;
        hasAssistantContent = true;
        break;
      case 'tool_call':
        pendingToolCalls.push({
          id: event.id,
          name: event.name,
          input: coerceToolInput(event.input),
        });
        hasAssistantContent = true;
        break;
      case 'turn_end':
        // Prefer the adapter-assembled assistant text when present; deltas
        // may not have streamed (turns-only adapters).
        if (event.assistantText && !pendingText) {
          pendingText = event.assistantText;
          hasAssistantContent = true;
        }
        flushAssistant();
        break;
      case 'tool_result':
        flushAssistant();
        out.push({
          role: 'tool',
          toolCallId: event.id,
          content: coerceToolOutput(event.output),
        });
        break;
      case 'agent_end':
        flushAssistant();
        break;
      case 'agent_start':
      case 'error':
      case 'native':
      case 'thinking':
        // Reasoning content is not part of conversation history; downstream
        // adapters should see the agent's text output, not its inner monologue.
        break;
    }
  }

  // A run that ends without a terminal turn_end/agent_end still flushes.
  flushAssistant();

  return out;
}

function coerceToolInput(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function coerceToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}
