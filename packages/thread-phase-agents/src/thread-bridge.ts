/**
 * Render a `Thread` into the input shape each adapter expects.
 *
 * Same-adapter handoff (claude-code → claude-code) uses the resume
 * token; native fidelity. Cross-adapter handoff (claude-code →
 * anthropic) loses the per-adapter native log and falls back to a
 * text rendering of the canonical event stream.
 *
 * These helpers turn `thread.events` into the next adapter's input
 * format. They're lossy by design — preserve the gist, not the
 * adapter-specific structure. For tighter fidelity, pass the
 * adapter's resume token via `injectResume.<adapter>` instead.
 *
 * @internal
 */

import {
  threadToMessages,
  type Thread,
} from 'thread-phase/agents';

import type { ContentBlock } from './acp/index.js';

// ---------------------------------------------------------------------------
// Internal: render a thread's events as a single text transcript
// ---------------------------------------------------------------------------

/**
 * Produce a text transcript of the thread suitable for splicing into
 * any adapter's prompt. Format is "[<source>] <text>" for assistant
 * turns, "[<source>:tool] <name>(<input>)" for tool calls,
 * "[<source>:result] <output>" for tool results. Skips native /
 * thinking / lifecycle events.
 *
 * Output is bounded by the thread's content; very long threads
 * produce very long transcripts — callers managing token budgets
 * should pre-trim or summarize.
 *
 * @internal
 */
export function threadToTranscript(thread: Thread): string {
  const lines: string[] = [];
  for (const event of thread.events) {
    switch (event.type) {
      case 'text': {
        // Accumulate text per source — but for simplicity emit each delta
        // as a separate line tagged with source. Lossy but unambiguous.
        lines.push(`[${event.source}] ${event.delta}`);
        break;
      }
      case 'tool_call': {
        const inputStr = safeJson(event.input);
        lines.push(`[${event.source}:tool_call ${event.name}] ${inputStr}`);
        break;
      }
      case 'tool_result': {
        const outputStr = typeof event.output === 'string' ? event.output : safeJson(event.output);
        const prefix = event.isError ? 'tool_error' : 'tool_result';
        lines.push(`[${event.source}:${prefix} ${event.name}] ${outputStr}`);
        break;
      }
      case 'turn_end': {
        // Assistant text from turn_end is redundant with prior text
        // deltas — skip unless no text was streamed (turns-only adapters).
        if (event.assistantText && event.toolCallCount === 0 && !lines.some((l) => l.startsWith(`[${event.source}] `))) {
          lines.push(`[${event.source}] ${event.assistantText}`);
        }
        break;
      }
      default:
        // skip agent_start, agent_end, error, native, thinking
        break;
    }
  }
  return lines.join('\n');
}

function safeJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// Per-adapter prompt-input renderers
// ---------------------------------------------------------------------------

/**
 * Render a thread as a single ACP `ContentBlock[]` (one text block).
 * Suitable for `acpAgent.adapter({ ..., prompt: threadToAcpPrompt(thread) })`
 * when a downstream adapter call shouldn't try same-session resume.
 *
 * @internal
 */
export function threadToAcpPrompt(thread: Thread): ContentBlock[] {
  const transcript = threadToTranscript(thread);
  return [{ type: 'text', text: transcript }];
}

/**
 * Render a thread as a plain string. Suitable for `claudeCodeAgent` or
 * any adapter that takes a single user-prompt string.
 *
 * @internal
 */
export function threadToClaudeCodePrompt(thread: Thread): string {
  return threadToTranscript(thread);
}

/**
 * Render a thread as a single text input for the OpenAI Responses API.
 * The Responses API's `input` field accepts a string or an items array;
 * we use the string form for cross-adapter handoff.
 *
 * @internal
 */
export function threadToCodexInput(thread: Thread): string {
  return threadToTranscript(thread);
}

/**
 * Render a thread as Anthropic `MessageParam[]` — currently a single
 * user message wrapping the transcript. Anthropic's role-based
 * conversation structure doesn't round-trip from canonical events
 * losslessly; for tighter fidelity, use Anthropic's own messages
 * array directly rather than crossing adapter boundaries.
 *
 * The return type is intentionally typed loosely as `unknown[]` to
 * avoid importing `@anthropic-ai/sdk` types from this module — the
 * runtime shape matches `MessageParam[]` (role: 'user' | 'assistant',
 * content: string), which is the broadly-compatible subset across
 * Anthropic SDK versions.
 *
 * @internal
 */
export function threadToAnthropicMessages(
  thread: Thread,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  // For now: collapse to a single user message containing the
  // transcript. Higher-fidelity conversion (turn-by-turn) is a
  // follow-up.
  const transcript = threadToTranscript(thread);
  return [{ role: 'user', content: transcript }];
}

/**
 * Render the thread's canonical event log to thread-phase's internal
 * `Message[]` shape. Re-exports the upstream `threadToMessages` so
 * sibling-package consumers can find all the bridge helpers in one
 * place.
 *
 * @internal
 */
export { threadToMessages };
