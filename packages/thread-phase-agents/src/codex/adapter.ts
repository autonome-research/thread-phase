/**
 * Codex adapter — in-process via the OpenAI SDK's Responses API.
 *
 * The Codex CLI itself is a wrapper around OpenAI's Responses API (per
 * hermes-agent's adapter design); rather than spawn the CLI as a
 * subprocess we call the Responses API directly. Auth uses the same
 * OPENAI_API_KEY as the openai package (the only one thread-phase
 * already depends on).
 *
 * Capabilities:
 *   streaming        'text'
 *   cancellation     'cooperative'
 *   resumption       'response-id'   (native previous_response_id)
 *   structuredOutput 'prompted'      (Responses API supports native
 *                                     response_format too — defer to
 *                                     a follow-up minor)
 *
 * Reasoning items surface as canonical `thinking` events. Function calls
 * (assembled from delta+done) surface as `tool_call` events; the caller
 * executes and feeds tool_results back via `input` on the next call.
 *
 * @internal
 */

import OpenAI from 'openai';
import type { Response, ResponseStreamEvent } from 'openai/resources/responses/responses.js';

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
  type ResumeToken,
  type SerializableError,
  type StructuredOutputConfig,
} from 'thread-phase/agents';
import type { ToolCall } from 'thread-phase';

const ADAPTER_ID = 'codex';

/** @internal */
export interface CodexAgentConfig {
  /** Model name, e.g. 'gpt-5' or 'gpt-5.1-mini'. */
  model: string;
  /**
   * Responses API input — a string for a single user message or an array
   * of input items (mixed user/assistant/function_call_output).
   */
  input: string | unknown[];
  /** System / instructions prompt. */
  instructions?: string;
  /** Optional tool definitions (function tools, etc.). */
  tools?: unknown[];
  /** Tool-choice control. */
  toolChoice?: unknown;
  /** max_output_tokens — default unset (model default). */
  maxOutputTokens?: number;
  /** Temperature. */
  temperature?: number;
  /** Resume from a prior response — passed as previous_response_id. */
  previousResponseId?: string;
  /** Reasoning config (effort level). */
  reasoning?: { effort?: 'low' | 'medium' | 'high' };
  /** Optional pre-built OpenAI client. Useful for DI in tests. */
  client?: OpenAI;
  /** API key. Defaults to OPENAI_API_KEY env var. */
  apiKey?: string;
  /** Base URL override. */
  baseURL?: string;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const codexAgent: AgentAdapterMeta<CodexAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'cooperative',
    resumption: 'response-id',
    structuredOutput: 'prompted',
  },
  adapter: createCodexAdapter,
});

function createCodexAdapter(
  config: CodexAgentConfig,
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
    let resumeToken: ResumeToken | undefined = config.previousResponseId
      ? { kind: 'response-id', id: config.previousResponseId, provider: 'openai' }
      : undefined;
    queue.push({ type: 'agent_start', source, traceId, resumeToken });

    const client =
      config.client ??
      new OpenAI({
        apiKey: config.apiKey,
        ...(config.baseURL !== undefined ? { baseURL: config.baseURL } : {}),
      });

    const effectiveInstructions = config.outputSchema
      ? applyStructuredOutputPrompt(config.instructions ?? '', config.outputSchema)
      : config.instructions;

    let assembledText = '';
    let responseId: string | null = null;
    let responseStatus: Response['status'] | null = null;
    let inputTokens = 0;
    let outputTokens = 0;
    const executedToolCalls: ToolCall[] = [];
    type FnState = { id: string; name: string; argsAcc: string };
    const fnByItemId = new Map<string, FnState>();

    try {
      const params: Record<string, unknown> = {
        model: config.model,
        input: config.input,
        ...(effectiveInstructions !== undefined ? { instructions: effectiveInstructions } : {}),
        ...(config.tools !== undefined ? { tools: config.tools } : {}),
        ...(config.toolChoice !== undefined ? { tool_choice: config.toolChoice } : {}),
        ...(config.maxOutputTokens !== undefined ? { max_output_tokens: config.maxOutputTokens } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.previousResponseId !== undefined ? { previous_response_id: config.previousResponseId } : {}),
        ...(config.reasoning !== undefined ? { reasoning: config.reasoning } : {}),
      };

      // openai SDK: client.responses.stream(params, { signal })
      const stream = client.responses.stream(
        params as Parameters<typeof client.responses.stream>[0],
        { signal: compositeSignal },
      );

      for await (const event of stream as AsyncIterable<ResponseStreamEvent>) {
        switch (event.type) {
          case 'response.created': {
            responseId = event.response?.id ?? responseId;
            break;
          }
          case 'response.output_text.delta': {
            assembledText += event.delta;
            turns.text(event.delta);
            break;
          }
          case 'response.reasoning_text.delta': {
            turns.thinking(event.delta);
            break;
          }
          case 'response.output_item.added': {
            const item = event.item as { type?: string; id?: string; name?: string };
            if (item.type === 'function_call' && item.id) {
              fnByItemId.set(item.id, {
                id: item.id,
                name: item.name ?? 'function',
                argsAcc: '',
              });
            }
            break;
          }
          case 'response.function_call_arguments.delta': {
            const fn = fnByItemId.get(event.item_id);
            if (fn) fn.argsAcc += event.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const fn = fnByItemId.get(event.item_id) ?? {
              id: event.item_id,
              name: (event as { name?: string }).name ?? 'function',
              argsAcc: event.arguments ?? '',
            };
            // Prefer the .done event's authoritative arguments.
            fn.argsAcc = event.arguments ?? fn.argsAcc;
            let parsedInput: Record<string, unknown> = {};
            if (fn.argsAcc.length > 0) {
              try {
                const j: unknown = JSON.parse(fn.argsAcc);
                if (j !== null && typeof j === 'object' && !Array.isArray(j)) {
                  parsedInput = j as Record<string, unknown>;
                }
              } catch {
                parsedInput = { _rawJson: fn.argsAcc };
              }
            }
            turns.toolCall(fn.id, fn.name, parsedInput);
            executedToolCalls.push({ id: fn.id, name: fn.name, input: parsedInput });
            fnByItemId.delete(event.item_id);
            break;
          }
          case 'response.completed': {
            responseId = event.response?.id ?? responseId;
            responseStatus = event.response?.status ?? responseStatus;
            if (event.response?.usage) {
              inputTokens = event.response.usage.input_tokens ?? inputTokens;
              outputTokens = event.response.usage.output_tokens ?? outputTokens;
            }
            break;
          }
          case 'response.failed':
          case 'response.incomplete': {
            responseStatus = event.response?.status ?? responseStatus;
            break;
          }
          default: {
            // Forward-compat for unhandled Responses events.
            turns.native(`openai:${event.type}`, event);
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
      if (responseId) {
        resumeToken = { kind: 'response-id', id: responseId, provider: 'openai' };
      }
      queue.push({ type: 'agent_end', source, traceId, reason, resumeToken });
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
        resumeToken,
      };
    }

    turns.close();
    const finishReason = mapResponseStatus(
      responseStatus,
      executedToolCalls.length > 0,
      compositeSignal.aborted,
    );

    let parsed: unknown = undefined;
    let parseError: SerializableError | undefined = undefined;
    if (config.outputSchema) {
      try {
        parsed = parseStructuredFromText(assembledText, config.outputSchema);
      } catch (err) {
        parseError = serializeError(err);
      }
    }

    if (responseId) {
      resumeToken = { kind: 'response-id', id: responseId, provider: 'openai' };
    }
    queue.push({ type: 'agent_end', source, traceId, reason: finishReason, resumeToken });
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
      resumeToken,
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

function mapResponseStatus(
  status: Response['status'] | null,
  hadToolCalls: boolean,
  aborted: boolean,
): AgentRunResult['finishReason'] {
  if (aborted) return 'aborted';
  switch (status) {
    case 'completed':
      return hadToolCalls ? 'tool_calls' : 'stop';
    case 'failed':
      return 'error';
    case 'incomplete':
      // Responses API uses 'incomplete' for max_output_tokens hits.
      return 'length';
    case 'cancelled':
      return 'aborted';
    case 'in_progress':
    case 'queued':
    case null:
      return 'unknown';
    default:
      return 'unknown';
  }
}
