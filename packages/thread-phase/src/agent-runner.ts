/**
 * Agent runner — the tool-use loop primitive.
 *
 * Given an agent config (system prompt, tools, model tier), a starting
 * conversation, and an executor for the tools, runs an iterated tool-use
 * loop against an OpenAI-compatible inference endpoint until the agent
 * produces final text or hits its round budget.
 *
 * Integrates the token-budget machinery: each round checks if the next
 * request would breach the compression / hard-stop thresholds, and
 * compresses old tool results in-place when needed.
 *
 * Translates between thread-phase's internal Message shape (see
 * messages.ts) and OpenAI's wire format at the call boundary, so the
 * rest of the framework stays SDK-agnostic.
 */

import type OpenAI from 'openai';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions.js';

import type {
  Message,
  AssistantMessage,
  ToolCall,
  ToolDefinition,
  ToolExecutor,
} from './messages.js';
import {
  TokenBudgetTracker,
  BudgetStatus,
  type BudgetCheck,
} from './context/token-budget.js';
import {
  TruncateAndCacheResultCapper,
  type ResultCapper,
} from './context/result-capper.js';
import {
  DeterministicCompressor,
  AggressiveCompressor,
  sanitizeToolPairs,
  type CompressorStrategy,
} from './context/compressor.js';
import type { PipelineCache } from './cache.js';

// ---------------------------------------------------------------------------
// Public types
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
   * (model, max_tokens, messages, tools), the runner's value wins.
   */
  extraBody?: Record<string, unknown>;
}

export interface ActivityEntry {
  agent: string;
  action: string;
  detail?: string;
}

export interface AgentRunResult {
  /** Final text output from the agent. May be JSON; caller can parseJSON it. */
  text: string;
  activity: ActivityEntry[];
}

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
}

// ---------------------------------------------------------------------------
// Retry classifier — tuned for OpenAI-compat endpoints (vLLM, OpenAI, Ollama).
// ---------------------------------------------------------------------------

function isRetryableError(err: unknown): boolean {
  const e = err as { message?: string; status?: number; statusCode?: number } | null;
  const message = e?.message ?? '';
  const status = e?.status ?? e?.statusCode ?? 0;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes('timeout') ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('overloaded') ||
    message.includes('rate_limit')
  );
}

// ---------------------------------------------------------------------------
// Internal ↔ OpenAI translation
// ---------------------------------------------------------------------------

function toOpenAIMessages(
  systemPrompt: string,
  messages: Message[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [{ role: 'system', content: systemPrompt }];
  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'assistant') {
      const out: ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: msg.content || null,
      };
      if (msg.toolCalls.length > 0) {
        out.tool_calls = msg.toolCalls.map(
          (tc): ChatCompletionMessageToolCall => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.input),
            },
          }),
        );
      }
      result.push(out);
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId,
        content: msg.content,
      });
    }
  }
  return result;
}

function toOpenAITools(tools: ToolDefinition[]): ChatCompletionTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    },
  }));
}

function fromOpenAIAssistant(
  content: string | null,
  toolCalls: ChatCompletionMessageToolCall[] | undefined,
): AssistantMessage {
  const calls: ToolCall[] = (toolCalls ?? []).map((tc) => {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      input = { _raw: tc.function.arguments };
    }
    return { id: tc.id, name: tc.function.name, input };
  });
  return {
    role: 'assistant',
    content: content ?? '',
    toolCalls: calls,
  };
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

export async function runAgentWithTools(
  config: AgentConfig,
  initialMessages: Message[],
  options: AgentRunnerOptions,
  agentLabel?: string,
): Promise<AgentRunResult> {
  const label = agentLabel ?? config.name;
  const activity: ActivityEntry[] = [];
  const cache = options.cache ?? null;
  const maxRetries = options.maxRetries ?? 1;

  const budgetTracker = options.budgetTracker ?? new TokenBudgetTracker();
  const cap = budgetTracker.getResultCap();
  const resultCapper =
    options.resultCapper ?? new TruncateAndCacheResultCapper(cap.maxChars, cap.previewChars);
  const compressor = options.compressor ?? new DeterministicCompressor();
  const aggressiveCompressor = options.aggressiveCompressor ?? new AggressiveCompressor();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let localMessages: Message[] = [...initialMessages];
      let forceOutput = false;

      for (let round = 0; round < config.maxToolRounds; round++) {
        // --- Layer 2: budget check (compress / hard-stop) ---
        const budget: BudgetCheck = budgetTracker.check(
          config.systemPrompt,
          localMessages,
          forceOutput ? [] : config.tools,
        );

        if (budget.status === BudgetStatus.HARD_STOP && !forceOutput) {
          activity.push({
            agent: label,
            action: 'budget_hard_stop',
            detail: `${budget.estimatedTokens} tokens (${(budget.budgetUsed * 100).toFixed(0)}%) — aggressive compression`,
          });
          localMessages = aggressiveCompressor.compress(localMessages, {
            protectFirst: 1,
            protectLast: 4,
            activityLog: activity,
          });
          localMessages = sanitizeToolPairs(localMessages);
          forceOutput = true;
        } else if (budget.status === BudgetStatus.COMPRESS) {
          activity.push({
            agent: label,
            action: 'budget_compress',
            detail: `${budget.estimatedTokens} tokens (${(budget.budgetUsed * 100).toFixed(0)}%) — compressing old results`,
          });
          localMessages = compressor.compress(localMessages, {
            protectFirst: 1,
            protectLast: 6,
            activityLog: activity,
          });
          localMessages = sanitizeToolPairs(localMessages);
        }

        const isLastRound = round === config.maxToolRounds - 1 || forceOutput;
        // The nudge only makes sense when the agent has tools; injecting it for
        // a no-tools agent confuses the model into returning empty content.
        const shouldNudge = isLastRound && config.tools.length > 0;

        const messagesForRequest: Message[] = shouldNudge
          ? [
              ...localMessages,
              {
                role: 'user',
                content:
                  'You are running out of tool rounds. Please produce your final output now based on what you have found so far.',
              },
            ]
          : localMessages;

        const openAiMessages = toOpenAIMessages(config.systemPrompt, messagesForRequest);
        // The openai SDK serializes `tools: undefined` as `"tools": null` in
        // the JSON body, which trips up vLLM/Qwen into a reasoning-only loop.
        // Only set the field when we actually want tools available.
        const sendTools = !isLastRound && config.tools.length > 0;

        // extraBody first so anything the runner sets explicitly wins on key collision.
        const requestBody: ChatCompletionCreateParamsNonStreaming = {
          ...(config.extraBody as Partial<ChatCompletionCreateParamsNonStreaming> | undefined),
          model: config.model,
          max_tokens: config.maxTokens,
          messages: openAiMessages,
        };
        if (sendTools) {
          requestBody.tools = toOpenAITools(config.tools);
        }

        const response = await options.client.chat.completions.create(requestBody);

        const choice = response.choices[0];
        if (!choice) {
          activity.push({ agent: label, action: 'empty_response' });
          return { text: '', activity };
        }

        const assistantMsg = fromOpenAIAssistant(
          choice.message.content,
          choice.message.tool_calls,
        );
        localMessages.push(assistantMsg);

        if (assistantMsg.content.trim() && assistantMsg.toolCalls.length > 0) {
          activity.push({
            agent: label,
            action: 'reasoning',
            detail: assistantMsg.content.trim().slice(0, 200),
          });
        }

        // No tool calls → final output, return.
        if (assistantMsg.toolCalls.length === 0) {
          return { text: assistantMsg.content, activity };
        }

        // Log tool calls.
        for (const tc of assistantMsg.toolCalls) {
          const summary = Object.entries(tc.input)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, 60))
            .join(', ');
          activity.push({
            agent: label,
            action: `tool:${tc.name}`,
            detail: summary.slice(0, 120),
          });
        }

        // Execute tools in parallel.
        const results = await Promise.all(
          assistantMsg.toolCalls.map((tc) => options.toolExecutor.execute(tc.name, tc.id, tc.input)),
        );

        // --- Layer 1: cap each tool result ---
        for (let i = 0; i < results.length; i++) {
          const r = results[i]!;
          const tc = assistantMsg.toolCalls[i]!;
          r.content = resultCapper.cap(r.content, tc.name, tc.id, cache);
          activity.push({
            agent: label,
            action: `result:${tc.name}`,
            detail: `${r.content.length} chars — ${r.content.slice(0, 80).replace(/\n/g, ' ')}`,
          });
        }

        // Append tool-result messages.
        for (const r of results) {
          localMessages.push({
            role: 'tool',
            toolCallId: r.toolCallId,
            content: r.content,
          });
        }
      }

      // Round budget exhausted with no final text output.
      activity.push({ agent: label, action: 'max_rounds_reached' });

      const lastAssistant = [...localMessages]
        .reverse()
        .find((m): m is AssistantMessage => m.role === 'assistant');

      return { text: lastAssistant?.content ?? '{}', activity };
    } catch (err: unknown) {
      const e = err as { message?: string };
      activity.push({ agent: label, action: 'error', detail: e.message?.slice(0, 120) });

      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = 2000 + Math.random() * 3000;
        activity.push({
          agent: label,
          action: 'retry',
          detail: `Retrying after ${e.message?.slice(0, 60)}`,
        });
        console.warn(
          `[${label}] retryable error, waiting ${Math.round(delay)}ms: ${e.message?.slice(0, 100)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      console.error(`[${label}] agent failed (attempt ${attempt + 1}):`, e.message);
      return {
        text: JSON.stringify({ _error: true, message: e.message }),
        activity,
      };
    }
  }

  return { text: '{}', activity };
}

// ---------------------------------------------------------------------------
// JSON parse helper — tolerant of code fences and surrounding prose.
// ---------------------------------------------------------------------------

export function parseJSON<T>(
  text: string,
  fallback: T,
  onError?: (preview: string, err: Error) => void,
): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braced = text.match(/(\{[\s\S]*\})/);
  const jsonStr = fenced ? fenced[1]! : braced ? braced[1]! : text;

  try {
    return JSON.parse(jsonStr.trim()) as T;
  } catch (err) {
    const preview = text.slice(0, 200);
    const errObj = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      onError(preview, errObj);
    } else {
      console.warn(
        `[parseJSON] failed to parse agent output, using fallback. Preview: "${preview}..."`,
        err,
      );
    }
    return fallback;
  }
}
