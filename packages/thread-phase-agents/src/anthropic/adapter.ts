/**
 * Anthropic adapter — in-process via `@anthropic-ai/sdk`.
 *
 * Single-turn. The adapter streams from `client.messages.stream(...)`,
 * translates Anthropic's RawMessageStreamEvent union to canonical
 * `AgentEvent`s, and returns when the stream ends. Tool-use loops are
 * the caller's responsibility — the adapter surfaces `tool_call` events
 * but does not execute tools; on subsequent calls the caller passes the
 * tool result back in `messages` as a user `tool_result` block.
 *
 * Capabilities:
 *   streaming        'text'
 *   cancellation     'cooperative'  (Anthropic SDK accepts an AbortSignal)
 *   resumption       'none'         (no native session id; pass history)
 *   structuredOutput 'prompted'     (uses thread-phase's <response> parser)
 *
 * Extended thinking surfaces as canonical `thinking` events. Vision /
 * citations / cache-control blocks pass through transparently in
 * config.messages; we don't intercept them.
 *
 * @internal
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  Tool as AnthropicTool,
  ToolChoice,
  StopReason as AnthropicStopReason,
  ThinkingConfigParam,
} from '@anthropic-ai/sdk/resources/messages.js';

import {
  applyStructuredOutputPrompt,
  composeAbort,
  createEventQueue,
  defineAgentAdapter,
  lazyEvents,
  parseStructuredFromText,
  serializeError,
  TurnAccumulator,
  type AgentAdapterMeta,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type SerializableError,
  type StructuredOutputConfig,
} from 'thread-phase/agents';
import type { ToolCall } from 'thread-phase';

const ADAPTER_ID = 'anthropic';

/** @internal */
export interface AnthropicAgentConfig {
  /** Model name, e.g. 'claude-opus-4-7' or 'claude-sonnet-4-6'. */
  model: string;
  /** Conversation messages. The adapter prepends/appends nothing. */
  messages: MessageParam[];
  /** System prompt. */
  systemPrompt?: string;
  /** Optional tools the model may call. The adapter emits tool_call events; the caller executes and feeds tool_result back on the next call. */
  tools?: AnthropicTool[];
  /** Tool-choice control. */
  toolChoice?: ToolChoice;
  /** max_tokens — default 4096. */
  maxTokens?: number;
  /** Temperature. */
  temperature?: number;
  /** Optional thinking config (extended thinking). */
  thinking?: ThinkingConfigParam;
  /** Optional pre-built client. Useful for DI in tests. */
  client?: Anthropic;
  /** API key. Defaults to ANTHROPIC_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. */
  baseURL?: string;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const anthropicAgent: AgentAdapterMeta<AnthropicAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'cooperative',
    resumption: 'none',
    structuredOutput: 'prompted',
  },
  adapter: createAnthropicAdapter,
});

function createAnthropicAdapter(
  config: AnthropicAgentConfig,
  options: AgentRunOptions = {},
): AgentRun {
  const source = ADAPTER_ID;
  const traceId = options.traceId;

  const { signal: compositeSignal, controller } = composeAbort(options.signal);
  const queue = createEventQueue(options.eventBus);
  const turns = new TurnAccumulator(queue.push, source, traceId);

  let started = false;
  let runPromise: Promise<AgentRunResult> | null = null;

  const startIfNeeded = (): Promise<AgentRunResult> => {
    if (runPromise) return runPromise;
    started = true;
    runPromise = runOnce();
    return runPromise;
  };

  async function runOnce(): Promise<AgentRunResult> {
    queue.push({ type: 'agent_start', source, traceId });

    const client = config.client ?? new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });

    const systemPrompt = config.outputSchema
      ? applyStructuredOutputPrompt(config.systemPrompt ?? '', config.outputSchema)
      : config.systemPrompt;

    let assembledText = '';
    let stopReason: AnthropicStopReason | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const executedToolCalls: ToolCall[] = [];
    type BlockState = { type: 'text' | 'thinking' | 'tool_use' | 'other'; toolId?: string; toolName?: string; jsonAcc?: string };
    const blocks: Record<number, BlockState> = {};

    try {
      const stream = client.messages.stream(
        {
          model: config.model,
          max_tokens: config.maxTokens ?? 4096,
          messages: config.messages,
          ...(systemPrompt !== undefined ? { system: systemPrompt } : {}),
          ...(config.tools !== undefined ? { tools: config.tools } : {}),
          ...(config.toolChoice !== undefined ? { tool_choice: config.toolChoice } : {}),
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          ...(config.thinking !== undefined ? { thinking: config.thinking } : {}),
        },
        { signal: compositeSignal },
      );

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            const m = event.message;
            if (m?.usage) {
              inputTokens = m.usage.input_tokens ?? inputTokens;
            }
            break;
          }
          case 'content_block_start': {
            const cb = event.content_block;
            if (cb.type === 'tool_use') {
              blocks[event.index] = {
                type: 'tool_use',
                toolId: cb.id,
                toolName: cb.name,
                jsonAcc: '',
              };
            } else if (cb.type === 'thinking') {
              blocks[event.index] = { type: 'thinking' };
            } else if (cb.type === 'text') {
              blocks[event.index] = { type: 'text' };
            } else {
              blocks[event.index] = { type: 'other' };
              turns.native('anthropic:content_block_start', cb);
            }
            break;
          }
          case 'content_block_delta': {
            const block = blocks[event.index];
            if (!block) break;
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              assembledText += delta.text;
              turns.text(delta.text);
            } else if (delta.type === 'thinking_delta') {
              turns.thinking(delta.thinking);
            } else if (delta.type === 'input_json_delta') {
              block.jsonAcc = (block.jsonAcc ?? '') + delta.partial_json;
            } else {
              // signature_delta, citations_delta, etc. — surface as native.
              turns.native(`anthropic:${delta.type}`, delta);
            }
            break;
          }
          case 'content_block_stop': {
            const block = blocks[event.index];
            if (block?.type === 'tool_use' && block.toolId && block.toolName) {
              let parsedInput: Record<string, unknown> = {};
              if (block.jsonAcc && block.jsonAcc.length > 0) {
                try {
                  const j: unknown = JSON.parse(block.jsonAcc);
                  if (j !== null && typeof j === 'object' && !Array.isArray(j)) {
                    parsedInput = j as Record<string, unknown>;
                  }
                } catch {
                  parsedInput = { _rawJson: block.jsonAcc };
                }
              }
              turns.toolCall(block.toolId, block.toolName, parsedInput);
              executedToolCalls.push({
                id: block.toolId,
                name: block.toolName,
                input: parsedInput,
              });
            }
            delete blocks[event.index];
            break;
          }
          case 'message_delta': {
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              outputTokens = event.usage.output_tokens ?? outputTokens;
            }
            break;
          }
          case 'message_stop': {
            // Stream ends after this. Final usage was on message_delta.
            break;
          }
          default: {
            // Forward-compat for new event types.
            turns.native(`anthropic:${(event as { type?: string }).type ?? 'unknown'}`, event);
            break;
          }
        }
      }
    } catch (err) {
      const aborted = compositeSignal.aborted;
      turns.close();
      queue.push({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: false,
      });
      const reason = aborted ? 'aborted' : 'error';
      queue.push({ type: 'agent_end', source, traceId, reason });
      queue.close();
      return {
        text: assembledText,
        finishReason: reason,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        executedToolCalls,
      };
    }

    turns.close();
    const finishReason = mapStopReason(stopReason, compositeSignal.aborted);

    let parsed: unknown = undefined;
    let parseError: SerializableError | undefined = undefined;
    if (config.outputSchema) {
      try {
        parsed = parseStructuredFromText(assembledText, config.outputSchema);
      } catch (err) {
        parseError = serializeError(err);
      }
    }

    queue.push({ type: 'agent_end', source, traceId, reason: finishReason });
    queue.close();

    return {
      text: assembledText,
      finishReason,
      usage: {
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      executedToolCalls,
      parsed,
      parseError,
    };
  }

  return {
    events: lazyEvents(queue.events, startIfNeeded),
    get result(): Promise<AgentRunResult> {
      return startIfNeeded();
    },
    abort(reason?: string): void {
      controller.abort(reason);
      if (!started) startIfNeeded();
    },
  };
}

function mapStopReason(
  reason: AnthropicStopReason | null,
  aborted: boolean,
): AgentRunResult['finishReason'] {
  if (aborted) return 'aborted';
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    case 'pause_turn':
    case null:
      return 'unknown';
    default:
      return 'unknown';
  }
}
