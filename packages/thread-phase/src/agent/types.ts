/**
 * Public types for the agent runner.
 *
 * Kept separate from the loop so callers can import the surface without
 * pulling in the streaming machinery, and so the type surface is easy to
 * audit at a glance.
 */

import type OpenAI from 'openai';
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutor,
  ToolResult,
} from '../messages.js';
import type { TokenBudgetTracker } from '../context/token-budget.js';
import type { ResultCapper } from '../context/result-capper.js';
import type { CompressorStrategy } from '../context/compressor.js';
import type { PipelineCache } from '../cache.js';

// ---------------------------------------------------------------------------
// Agent configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Identifier surfaced in activity logs. */
  name: string;
  systemPrompt: string;
  /** Model name passed to the inference endpoint. Empty string → caller-default. */
  model: string;
  tools: ToolDefinition[];
  /** Max rounds of tool use before forcing a final response. */
  maxToolRounds: number;
  /** Max tokens for the model's response. */
  maxTokens: number;
  /**
   * Extra fields merged into the chat-completions request body. Use for
   * provider-specific extensions that aren't in the OpenAI spec — e.g. vLLM's
   * `chat_template_kwargs: { enable_thinking: false }` to disable Qwen3 reasoning,
   * or `top_k`, `repetition_penalty`, etc.
   *
   * Merged via spread; if a key collides with one the runner sets explicitly
   * (model, max_tokens, messages, tools, stream), the runner's value wins.
   */
  extraBody?: Record<string, unknown>;
}

export interface ActivityEntry {
  agent: string;
  action: string;
  detail?: string;
}

/**
 * `finishReason` mirrors OpenAI's `choices[0].finish_reason`. Callers that
 * need to detect truncation should branch on `'length'` (= max_tokens hit,
 * output cut off mid-stream). `'unknown'` is used when the backend never
 * surfaced a reason (e.g. a stream that errored mid-flight).
 */
export type FinishReason =
  | 'stop'
  | 'length'
  | 'tool_calls'
  | 'content_filter'
  | 'function_call'
  | 'error'
  | 'unknown';

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AgentRunResult {
  /** Final text output from the agent. May be JSON; caller can parseJSON it. */
  text: string;
  activity: ActivityEntry[];
  /**
   * Reason the agent stopped. `'stop'` = clean finish, `'length'` = truncated
   * (max_tokens hit), `'tool_calls'` = stopped to call tools (rare at the top
   * level since the loop continues), `'error'` = surfaced from a thrown error
   * inside the loop, `'unknown'` = backend never reported one.
   */
  finishReason: FinishReason;
  /** Token usage summed across every inference round in this run. */
  usage: UsageInfo;
  /**
   * Every tool call the agent actually executed during this run, in order.
   * Use this rather than parsing `activity[]` to verify what the agent did
   * vs. what it claimed in its text/JSON output.
   */
  executedToolCalls: ToolCall[];
}

/**
 * Streaming events fed to `AgentRunnerOptions.onStreamEvent`.
 *
 * - `content_delta`: chunk of model content as it streams.
 * - `tool_call_started`: assistant emitted a tool call (post-decode).
 * - `tool_call_complete`: tool executed, result capped, content available.
 * - `round_complete`: one tool-use round just finished.
 */
export type AgentStreamEvent =
  | { type: 'content_delta'; agent: string; delta: string }
  | { type: 'tool_call_started'; agent: string; toolCall: ToolCall }
  | { type: 'tool_call_complete'; agent: string; toolCall: ToolCall; result: ToolResult }
  | { type: 'round_complete'; agent: string; round: number; finishReason: FinishReason };

export interface AgentRunnerOptions {
  client: OpenAI;
  toolExecutor: ToolExecutor;
  /** Per-pipeline cache shared with the result capper for full-result retrieval. */
  cache?: PipelineCache | null;
  budgetTracker?: TokenBudgetTracker;
  resultCapper?: ResultCapper;
  compressor?: CompressorStrategy;
  aggressiveCompressor?: CompressorStrategy;
  /** Number of full retry attempts on retryable errors (default 1 = retry once). */
  maxRetries?: number;
  /**
   * Cancellation signal. When aborted: the in-flight stream is cancelled
   * (passed through to `client.chat.completions.create({ signal })`), the
   * loop stops between rounds, and the runner returns whatever it has so far
   * with `finishReason: 'error'`.
   */
  signal?: AbortSignal;
  /**
   * Optional streaming sink. Receives content deltas as they arrive plus
   * tool-call lifecycle events. Synchronous callbacks only — don't await
   * inside; if you need async work, schedule it.
   */
  onStreamEvent?: (event: AgentStreamEvent) => void;
  /**
   * Defensive validation hook called once per run, just before returning.
   * Receives the assembled `AgentRunResult` (with `executedToolCalls` already
   * populated) and may either return a transformed result or throw to mark
   * the run as failed. Use this to verify the agent's claimed output against
   * what was actually executed — the canonical way to catch silent
   * confabulation where a small model says "I created file X" without ever
   * calling the write tool.
   */
  verifyResult?: (result: AgentRunResult) => Promise<AgentRunResult> | AgentRunResult;
}
