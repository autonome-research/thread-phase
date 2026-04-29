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

import type {
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions.js';

import type {
  Message,
  AssistantMessage,
  ToolCall,
} from '../messages.js';
import {
  TokenBudgetTracker,
  BudgetStatus,
  type BudgetCheck,
} from '../context/token-budget.js';
import { TruncateAndCacheResultCapper } from '../context/result-capper.js';
import {
  DeterministicCompressor,
  AggressiveCompressor,
  sanitizeToolPairs,
} from '../context/compressor.js';

import type {
  ActivityEntry,
  AgentConfig,
  AgentRunnerOptions,
  AgentRunResult,
  FinishReason,
  UsageInfo,
} from './types.js';
import { toOpenAIMessages, toOpenAITools } from './openai-adapter.js';
import { consumeStream, looksLikeToolCallText } from './stream-consumer.js';
import { isRetryableError, isAbortError } from './retry.js';

export async function runAgentWithTools(
  config: AgentConfig,
  initialMessages: Message[],
  options: AgentRunnerOptions,
  agentLabel?: string,
): Promise<AgentRunResult> {
  const label = agentLabel ?? config.name;
  const activity: ActivityEntry[] = [];
  const executedToolCalls: ToolCall[] = [];
  const cumulativeUsage: UsageInfo = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  const cache = options.cache ?? null;
  const maxRetries = options.maxRetries ?? 1;
  const signal = options.signal;
  const emit = options.onStreamEvent;

  const budgetTracker = options.budgetTracker ?? new TokenBudgetTracker();
  const cap = budgetTracker.getResultCap();
  const protect = budgetTracker.getProtectCounts();
  const resultCapper =
    options.resultCapper ?? new TruncateAndCacheResultCapper(cap.maxChars, cap.previewChars);
  const compressor = options.compressor ?? new DeterministicCompressor();
  const aggressiveCompressor = options.aggressiveCompressor ?? new AggressiveCompressor();

  // Helper: compose the final result, run the verifyResult hook (if any),
  // and surface a clean error result if the hook rejects.
  const finalize = async (
    text: string,
    finishReason: FinishReason,
  ): Promise<AgentRunResult> => {
    let result: AgentRunResult = {
      text,
      activity,
      finishReason,
      usage: cumulativeUsage,
      executedToolCalls,
    };
    if (options.verifyResult) {
      try {
        const verified = await options.verifyResult(result);
        if (verified) result = verified;
      } catch (err) {
        const e = err as { message?: string };
        activity.push({
          agent: label,
          action: 'verify_failed',
          detail: e.message?.slice(0, 200),
        });
        return {
          ...result,
          text: JSON.stringify({ _error: true, message: e.message ?? 'verifyResult threw' }),
          finishReason: 'error',
        };
      }
    }
    return result;
  };

  // Surface a clear cancellation result when the caller aborts before the
  // first round.
  if (signal?.aborted) {
    activity.push({ agent: label, action: 'aborted', detail: 'signal aborted before first round' });
    return finalize('', 'error');
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      let localMessages: Message[] = [...initialMessages];
      let forceOutput = false;

      for (let round = 0; round < config.maxToolRounds; round++) {
        if (signal?.aborted) {
          activity.push({ agent: label, action: 'aborted', detail: `aborted before round ${round}` });
          return finalize(
            [...localMessages]
              .reverse()
              .find((m): m is AssistantMessage => m.role === 'assistant')?.content ?? '',
            'error',
          );
        }

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
            protectFirst: protect.protectFirst,
            protectLast: protect.protectLastAggressive,
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
            protectFirst: protect.protectFirst,
            protectLast: protect.protectLast,
            activityLog: activity,
          });
          localMessages = sanitizeToolPairs(localMessages);
        }

        const isLastRound = round === config.maxToolRounds - 1 || forceOutput;
        // The nudge only makes sense when the agent has tools; injecting it
        // for a no-tools agent confuses the model into returning empty content.
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
        const requestBody: ChatCompletionCreateParamsStreaming = {
          ...(config.extraBody as Partial<ChatCompletionCreateParamsStreaming> | undefined),
          model: config.model,
          max_tokens: config.maxTokens,
          messages: openAiMessages,
          stream: true,
          // Ask backends that support it to include usage in the terminal
          // chunk. Backends that don't support it ignore the field.
          stream_options: { include_usage: true },
        };
        if (sendTools) {
          requestBody.tools = toOpenAITools(config.tools);
        }

        const stream = await options.client.chat.completions.create(requestBody, {
          signal,
        });

        const round_ = await consumeStream(stream, (delta) => {
          emit?.({ type: 'content_delta', agent: label, delta });
        });

        // Roll usage forward across rounds.
        cumulativeUsage.promptTokens += round_.usage.promptTokens;
        cumulativeUsage.completionTokens += round_.usage.completionTokens;
        cumulativeUsage.totalTokens += round_.usage.totalTokens;

        // Inference-provider parser-mismatch warning: tools[] was sent but
        // the model returned plain content shaped like a tool call. Likely
        // a missing or wrong --tool-call-parser on the backend.
        if (
          sendTools &&
          round_.toolCalls.length === 0 &&
          looksLikeToolCallText(round_.content)
        ) {
          const hint =
            'tools[] was sent but model returned tool-call-shaped content as plain text. ' +
            'Likely a missing or wrong --tool-call-parser on the inference backend.';
          activity.push({ agent: label, action: 'parser_mismatch_warning', detail: hint });
          // eslint-disable-next-line no-console
          console.warn(`[${label}] ${hint} Preview: ${round_.content.slice(0, 160)}`);
        }

        const assistantMsg: AssistantMessage = {
          role: 'assistant',
          content: round_.content,
          toolCalls: round_.toolCalls,
        };
        localMessages.push(assistantMsg);

        if (assistantMsg.content.trim() && assistantMsg.toolCalls.length > 0) {
          activity.push({
            agent: label,
            action: 'reasoning',
            detail: assistantMsg.content.trim().slice(0, 200),
          });
        }

        emit?.({
          type: 'round_complete',
          agent: label,
          round,
          finishReason: round_.finishReason,
        });

        // No tool calls → final output, return.
        if (assistantMsg.toolCalls.length === 0) {
          return finalize(assistantMsg.content, round_.finishReason);
        }

        // Log tool calls + emit lifecycle events.
        for (const tc of assistantMsg.toolCalls) {
          const summary = Object.entries(tc.input)
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`.slice(0, 60))
            .join(', ');
          activity.push({
            agent: label,
            action: `tool:${tc.name}`,
            detail: summary.slice(0, 120),
          });
          emit?.({ type: 'tool_call_started', agent: label, toolCall: tc });
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
          executedToolCalls.push(tc);
          emit?.({ type: 'tool_call_complete', agent: label, toolCall: tc, result: r });
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

      // We ran out of rounds while the model still wanted to call tools.
      // Surface that as 'length'-adjacent: incomplete from the model's
      // perspective, even if the wire-level reason was 'tool_calls'.
      return finalize(lastAssistant?.content ?? '{}', 'length');
    } catch (err: unknown) {
      const e = err as { message?: string };

      if (isAbortError(err)) {
        activity.push({ agent: label, action: 'aborted', detail: e.message?.slice(0, 120) });
        return finalize('', 'error');
      }

      activity.push({ agent: label, action: 'error', detail: e.message?.slice(0, 120) });

      if (attempt < maxRetries && isRetryableError(err)) {
        const delay = 2000 + Math.random() * 3000;
        activity.push({
          agent: label,
          action: 'retry',
          detail: `Retrying after ${e.message?.slice(0, 60)}`,
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[${label}] retryable error, waiting ${Math.round(delay)}ms: ${e.message?.slice(0, 100)}`,
        );
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      // eslint-disable-next-line no-console
      console.error(`[${label}] agent failed (attempt ${attempt + 1}):`, e.message);
      return finalize(
        JSON.stringify({ _error: true, message: e.message }),
        'error',
      );
    }
  }

  return finalize('{}', 'error');
}
