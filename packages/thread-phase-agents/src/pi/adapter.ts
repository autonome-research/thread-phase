/**
 * Pi adapter — in-process via `@mariozechner/pi-coding-agent`.
 *
 * Pi is a fully-featured TypeScript coding agent SDK. Unlike the
 * subprocess-based adapters (claude-code, codex-cli, ACP), pi runs in
 * the same Node process: the adapter calls `createAgentSession`,
 * subscribes to its event stream, and forwards each event into the
 * canonical AgentEvent vocabulary.
 *
 * The headline difference from every other adapter: **pi supports
 * native mid-stream steering and follow-up.** This is the first
 * adapter where both `steer()` and `followUp()` on
 * `SteerableAgentRun` actually work at runtime — pi accepts new
 * messages while the model is still generating.
 *
 * Capabilities:
 *   streaming        'text'
 *   cancellation     'cooperative'   (session.abort())
 *   resumption       'session-file'  (pi's SessionManager persists to disk)
 *   structuredOutput 'prompted'
 *
 * Event translation:
 *   pi agent_start                  -> canonical agent_start
 *   pi message_update + text_delta  -> canonical text
 *   pi message_update + thinking_*  -> canonical thinking
 *   pi tool_execution_start         -> canonical tool_call
 *   pi tool_execution_end           -> canonical tool_result
 *   pi turn_end                     -> canonical turn_end (via endTurn)
 *   pi agent_end                    -> canonical agent_end
 *   everything else                 -> native events (kind: 'pi:*')
 *
 * @internal
 */

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
  type SteerableAgentRun,
  type StructuredOutputConfig,
} from 'thread-phase/agents';
import type { ToolCall } from 'thread-phase';

// We use the SDK's public re-exports, kept as `unknown` here to avoid
// pulling pi's transitive type-only generics across the type boundary.
// Runtime calls happen via dynamic import to keep load-time costs out of
// the consumer's path when they don't use pi.
type AgentSession = unknown;
type AgentSessionEvent = unknown;

const ADAPTER_ID = 'pi';

/** @internal */
export interface PiAgentConfig {
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Prompt text sent to `session.prompt`. */
  prompt: string;
  /**
   * Resume a specific pi session file. Mutually exclusive with
   * `continueSession`. The path is exposed as `ResumeToken{ kind:
   * 'session-file' }` on agent_start and agent_end.
   */
  resumeSessionFile?: string;
  /**
   * Continue the most recent session in cwd. Equivalent to passing
   * `continueSession: true` to `createAgentSession`.
   */
  continueSession?: boolean;
  /**
   * Pi model object — pass `getModel('provider', 'model')` from
   * `@mariozechner/pi-ai`. When omitted, pi uses the default from
   * settings.json.
   */
  model?: unknown;
  /** Thinking level override. */
  thinkingLevel?: 'low' | 'medium' | 'high';
  /**
   * Additional options forwarded to `createAgentSession`. Use this to
   * pass tools, customTools, extensions, auth storage, etc.
   */
  sessionOptions?: Record<string, unknown>;
  /**
   * Pre-built pi session — bypasses `createAgentSession` entirely.
   * Useful for tests and for callers managing the session lifecycle
   * themselves. When provided, the adapter does NOT dispose the
   * session at run end.
   */
  session?: AgentSession;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const piAgent: AgentAdapterMeta<PiAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'cooperative',
    resumption: 'session-file',
    structuredOutput: 'prompted',
  },
  adapter: createPiAdapter,
});

function createPiAdapter(config: PiAgentConfig, options: AgentRunOptions = {}): AgentRun {
  const source = ADAPTER_ID;
  const traceId = options.traceId;

  const { signal: compositeSignal, controller } = composeAbort(options.signal);
  const queue = createEventQueue(options.eventBus);
  const turns = new TurnAccumulator(queue.push, source, traceId);

  // Track session for steer/followUp/abort.
  let activeSession: PiSessionLike | null = null;
  let hasEnded = false;

  let started = false;
  let runPromise: Promise<AgentRunResult> | null = null;
  const startIfNeeded = (): Promise<AgentRunResult> => {
    if (runPromise) return runPromise;
    started = true;
    runPromise = runOnce();
    return runPromise;
  };

  async function runOnce(): Promise<AgentRunResult> {
    let resumeToken: ResumeToken | undefined = config.resumeSessionFile
      ? { kind: 'session-file', path: config.resumeSessionFile }
      : undefined;
    queue.push({ type: 'agent_start', source, traceId, resumeToken });

    const effectivePrompt = config.outputSchema
      ? `${config.prompt}\n\n${applyStructuredOutputPrompt('', config.outputSchema)}`
      : config.prompt;

    let assembledText = '';
    let finishReason: AgentRunResult['finishReason'] = 'unknown';
    let inputTokens = 0;
    let outputTokens = 0;
    const executedToolCalls: ToolCall[] = [];
    let sessionId: string | undefined;
    let ownsSession = false;

    try {
      let session: PiSessionLike;
      if (config.session) {
        session = config.session as PiSessionLike;
      } else {
        // Dynamic import keeps pi-coding-agent out of the type/runtime
        // path for consumers who don't use this adapter.
        const piModule = await import('@mariozechner/pi-coding-agent');
        const factory = (piModule as { createAgentSession?: (opts: unknown) => Promise<{ session: unknown }> }).createAgentSession;
        if (typeof factory !== 'function') {
          throw new Error('@mariozechner/pi-coding-agent: createAgentSession not exported');
        }
        const result = await factory({
          cwd: config.cwd ?? process.cwd(),
          continueSession: config.continueSession,
          resumeSessionFile: config.resumeSessionFile,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          ...config.sessionOptions,
        });
        session = result.session as PiSessionLike;
        ownsSession = true;
      }
      activeSession = session;

      // Subscribe and translate events.
      const unsubscribe = session.subscribe((event: PiAgentSessionEvent) => {
        try {
          translateEvent(event);
        } catch (err) {
          queue.push({
            type: 'error',
            source,
            traceId,
            error: serializeError(err),
            transient: false,
          });
        }
      });

      function translateEvent(event: PiAgentSessionEvent): void {
        if (event === null || typeof event !== 'object') return;
        const eventType = (event as { type?: string }).type;

        switch (eventType) {
          case 'agent_start': {
            // pi emits its own agent_start; we already emitted ours.
            // Forward as native so the audit log keeps both.
            turns.native('pi:agent_start', event);
            return;
          }
          case 'agent_end': {
            // Stop reason comes from the last assistant message. Usage is
            // captured per-turn via turn_end events — DO NOT re-add it
            // here, since agent_end.messages contains every assistant
            // message of the run and would double-count.
            const messages = (event as { messages?: PiAssistantMessage[] }).messages ?? [];
            const last = messages[messages.length - 1];
            if (last) {
              finishReason = mapStopReason(last.stopReason);
              if (typeof last.errorMessage === 'string' && last.errorMessage) {
                queue.push({
                  type: 'error',
                  source,
                  traceId,
                  error: { name: 'PiAgentError', message: last.errorMessage },
                  transient: false,
                });
              }
              if (typeof last.sessionId === 'string') sessionId = last.sessionId;
            }
            turns.native('pi:agent_end', event);
            return;
          }
          case 'turn_start': {
            turns.native('pi:turn_start', event);
            return;
          }
          case 'turn_end': {
            const turnMsg = (event as { message?: PiAssistantMessage }).message;
            if (turnMsg?.usage) {
              const usage = {
                promptTokens: Number(turnMsg.usage.input) || 0,
                completionTokens: Number(turnMsg.usage.output) || 0,
                totalTokens:
                  (Number(turnMsg.usage.input) || 0) + (Number(turnMsg.usage.output) || 0),
              };
              turns.endTurn(usage);
              inputTokens += usage.promptTokens;
              outputTokens += usage.completionTokens;
            } else {
              turns.endTurn();
            }
            return;
          }
          case 'message_update': {
            const inner = (event as { assistantMessageEvent?: PiAssistantMessageEvent }).assistantMessageEvent;
            if (!inner) return;
            switch (inner.type) {
              case 'text_delta': {
                const delta = typeof inner.delta === 'string' ? inner.delta : '';
                if (delta) {
                  assembledText += delta;
                  turns.text(delta);
                }
                return;
              }
              case 'thinking_delta': {
                const delta = typeof inner.delta === 'string' ? inner.delta : '';
                if (delta) turns.thinking(delta);
                return;
              }
              case 'toolcall_end': {
                // Tool call args finalized inside the message stream.
                // The canonical tool_call event fires from
                // `tool_execution_start` below — surface the inner
                // event as native for audit.
                turns.native('pi:toolcall_end', inner);
                return;
              }
              default: {
                turns.native(`pi:message_update:${inner.type}`, inner);
                return;
              }
            }
          }
          case 'tool_execution_start': {
            const e = event as PiToolExecEvent;
            const input: Record<string, unknown> =
              e.args && typeof e.args === 'object' && !Array.isArray(e.args)
                ? (e.args as Record<string, unknown>)
                : { value: e.args };
            turns.toolCall(e.toolCallId, e.toolName, input);
            executedToolCalls.push({ id: e.toolCallId, name: e.toolName, input });
            return;
          }
          case 'tool_execution_end': {
            const e = event as PiToolExecEvent;
            turns.toolResult(e.toolCallId, e.toolName, e.result, e.isError === true);
            return;
          }
          case 'tool_execution_update': {
            turns.native('pi:tool_execution_update', event);
            return;
          }
          case 'message_start':
          case 'message_end': {
            turns.native(`pi:${eventType}`, event);
            return;
          }
          default: {
            turns.native(`pi:${eventType ?? 'unknown'}`, event);
            return;
          }
        }
      }

      // Wire abort. Pi's session.abort() is async and graceful.
      const onAbort = (): void => {
        try {
          void session.abort();
        } catch {
          // best-effort
        }
      };
      if (compositeSignal.aborted) {
        onAbort();
      } else {
        compositeSignal.addEventListener('abort', onAbort, { once: true });
      }

      try {
        await session.prompt(effectivePrompt);
      } catch (err) {
        queue.push({
          type: 'error',
          source,
          traceId,
          error: serializeError(err),
          transient: false,
        });
        if (compositeSignal.aborted && finishReason === 'unknown') {
          finishReason = 'aborted';
        } else if (finishReason === 'unknown') {
          finishReason = 'error';
        }
      }

      unsubscribe();

      // If agent_end never fired (rare), close the accumulator.
      turns.close();

      if (finishReason === 'unknown' && compositeSignal.aborted) {
        finishReason = 'aborted';
      }
      if (sessionId) {
        // Pi sessions can be looked up by id via SessionManager. Surface
        // the id alongside the session file when available.
        resumeToken = { kind: 'opaque', data: sessionId };
      }

      let parsed: unknown = undefined;
      let parseError: SerializableError | undefined = undefined;
      // finishReason can be any AgentFinishReason (set via translateEvent
      // callback which TS can't flow-analyze); cast through unknown to
      // bypass the narrowed view TS infers from the catch path.
      if (config.outputSchema && (finishReason as unknown) === 'stop') {
        try {
          parsed = parseStructuredFromText(assembledText, config.outputSchema);
        } catch (err) {
          parseError = serializeError(err);
        }
      }

      queue.push({ type: 'agent_end', source, traceId, reason: finishReason, resumeToken });
      hasEnded = true;
      queue.close();

      if (ownsSession) {
        try {
          session.dispose();
        } catch {
          // ignore disposal errors
        }
      }

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
      queue.push({ type: 'agent_end', source, traceId, reason, resumeToken });
      hasEnded = true;
      queue.close();
      return {
        text: assembledText,
        finishReason: reason,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
        resumeToken,
      };
    }
  }

  // Returned object includes the SteerableAgentRun shape — pi natively
  // supports both steer() and followUp().
  const run: SteerableAgentRun = {
    events: lazyEvents(queue.events, startIfNeeded),
    get result(): Promise<AgentRunResult> {
      return startIfNeeded();
    },
    abort(reason?: string): void {
      controller.abort(reason);
      if (!started) startIfNeeded();
    },
    async steer(message: string): Promise<void> {
      if (hasEnded) {
        throw new Error('cannot steer after agent_end');
      }
      const session = activeSession;
      if (!session) {
        throw new Error('cannot steer before the pi session has started');
      }
      await session.steer(message);
    },
    async followUp(message: string): Promise<void> {
      if (hasEnded) {
        throw new Error('cannot followUp after agent_end');
      }
      const session = activeSession;
      if (!session) {
        throw new Error('cannot followUp before the pi session has started');
      }
      await session.followUp(message);
    },
  };

  return run as AgentRun;
}

function mapStopReason(reason: unknown): AgentRunResult['finishReason'] {
  if (typeof reason !== 'string') return 'unknown';
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'toolUse':
      return 'tool_calls';
    case 'error':
      return 'error';
    case 'aborted':
      return 'aborted';
    default:
      return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Loose structural types for the pi surface we touch
// ---------------------------------------------------------------------------

interface PiSessionLike {
  subscribe(listener: (event: PiAgentSessionEvent) => void): () => void;
  prompt(text: string, options?: unknown): Promise<void>;
  steer(text: string, images?: unknown): Promise<void>;
  followUp(text: string, images?: unknown): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
}

type PiAgentSessionEvent = AgentSessionEvent;

interface PiAssistantMessage {
  stopReason?: string;
  errorMessage?: string;
  sessionId?: string;
  usage?: { input?: number; output?: number };
}

interface PiAssistantMessageEvent {
  type: string;
  delta?: string;
  [key: string]: unknown;
}

interface PiToolExecEvent {
  toolCallId: string;
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}
