/**
 * ACP chassis — `AgentAdapter` that consumes any ACP-speaking subprocess.
 *
 * Lifecycle: spawn → initialize → session/new (or session/load on resume)
 * → session/prompt → stream session/update notifications → await
 * stopReason → emit agent_end → dispose.
 *
 * Translation table:
 *   session/update { sessionUpdate: 'agent_message_chunk' }   → text event
 *   session/update { sessionUpdate: 'agent_thought_chunk' }   → thinking event
 *   session/update { sessionUpdate: 'tool_call' }             → tool_call event
 *   session/update { sessionUpdate: 'tool_call_update', status: 'completed' }
 *                                                              → tool_result event
 *   everything else                                            → native event
 *
 * Cancellation: forceful. abort() sends session/cancel as a notification,
 * then SIGTERM after a short grace window, then SIGKILL. Subprocess
 * cleanup is unconditional on result resolution.
 *
 * Resumption: 'opaque' — the ACP session id is wrapped in a
 * `ResumeToken{ kind: 'opaque', data: sessionId }` and emitted on
 * agent_start (when input resume) and agent_end (always).
 *
 * @internal
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import {
  composeAbort,
  createEventQueue,
  defineAgentAdapter,
  lazyEvents,
  serializeError,
  TurnAccumulator,
  type AgentAdapterMeta,
  type AgentEvent,
  type AgentRun,
  type AgentRunOptions,
  type AgentRunResult,
  type ResumeToken,
} from 'thread-phase/agents';

import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  contentBlockToText,
  type CancelNotificationParams,
  type ContentBlock,
  type Implementation,
  type InitializeRequest,
  type InitializeResponse,
  type LoadSessionRequest,
  type McpServer,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotificationParams,
  type SessionUpdate,
  type StopReason,
  type ClientCapabilities,
} from './types.js';
import { createAcpTransport, type AcpTransport, JsonRpcCallError } from './transport.js';

/** @internal */
export interface AcpAgentConfig {
  /** Subprocess executable. */
  command: string;
  /** Arguments. */
  args?: string[];
  /** Working directory advertised to the agent at session/new. Required by ACP. */
  cwd: string;
  /** Subprocess working directory; defaults to `cwd`. */
  subprocessCwd?: string;
  /** Spawn env overrides. Merged with process.env. */
  env?: Record<string, string>;
  /** The prompt. String is wrapped into a single text content block. */
  prompt: string | ContentBlock[];
  /** MCP servers passed to session/new. Default: []. */
  mcpServers?: McpServer[];
  /** Client info for the initialize handshake. */
  clientInfo?: Implementation;
  /** Client capabilities declared at initialize. */
  clientCapabilities?: ClientCapabilities;
  /**
   * If set, the chassis calls session/load instead of session/new and
   * the agent resumes from this id. Requires the agent to declare
   * `loadSession: true` in its capabilities; if it doesn't, an error
   * event is emitted and the run ends with finishReason: 'error'.
   */
  resumeSessionId?: string;
  /**
   * How to respond to session/request_permission. Default 'deny' for
   * safety — coding agents calling destructive tools shouldn't proceed
   * silently unless the caller has opted in.
   */
  permissionMode?: 'allow' | 'deny';
  /**
   * Grace period in ms between session/cancel and SIGTERM on abort.
   * Default 2000.
   */
  cancelGraceMs?: number;
  /**
   * Grace period in ms between SIGTERM and SIGKILL when the subprocess
   * refuses to exit. Default 3000.
   */
  killGraceMs?: number;
}

/** @internal */
export interface CreateAcpAdapterOptions {
  /** Stable id, surfaced on every event's `source`. Default 'acp'. */
  id?: string;
}

/**
 * Build an ACP-speaking adapter with the given id. The chassis itself
 * is exported as `acpAgent` (id 'acp'); wrappers like `hermesAgent` and
 * `openClawAgent` are produced by calling this with their own id.
 *
 * @internal
 */
export function createAcpAdapter(
  opts: CreateAcpAdapterOptions = {},
): AgentAdapterMeta<AcpAgentConfig> {
  const id = opts.id ?? 'acp';
  return defineAgentAdapter<AcpAgentConfig>({
    id,
    capabilities: {
      streaming: 'text',
      cancellation: 'forceful',
      resumption: 'opaque',
      structuredOutput: 'prompted',
    },
    adapter: (config, options) => makeAcpRun(id, config, options ?? {}),
  });
}

/** The unparameterized chassis adapter. @internal */
export const acpAgent = createAcpAdapter({ id: 'acp' });

// ---------------------------------------------------------------------------
// run construction
// ---------------------------------------------------------------------------

function makeAcpRun(source: string, config: AcpAgentConfig, options: AgentRunOptions): AgentRun {
  const traceId = options.traceId;
  const cancelGraceMs = config.cancelGraceMs ?? 2000;
  const killGraceMs = config.killGraceMs ?? 3000;

  const { signal: compositeSignal, controller } = composeAbort(options.signal);
  const queue = createEventQueue(options.eventBus);
  const pushEvent = queue.push;
  const closeStream = queue.close;

  const turns = new TurnAccumulator(pushEvent, source, traceId);

  // Follow-up queue: messages to send as additional session/prompt requests
  // after the current prompt completes. Synchronously drained between turns
  // (the loop checks for new messages each iteration; no callback timing).
  const followUpQueue: string[] = [];
  let hasEnded = false;

  // Lazy start.
  let started = false;
  let runPromise: Promise<AgentRunResult> | null = null;
  const startIfNeeded = (): Promise<AgentRunResult> => {
    if (runPromise) return runPromise;
    started = true;
    runPromise = runOnce();
    return runPromise;
  };

  async function runOnce(): Promise<AgentRunResult> {
    let resumeToken: ResumeToken | undefined = config.resumeSessionId
      ? { kind: 'opaque', data: config.resumeSessionId }
      : undefined;
    pushEvent({ type: 'agent_start', source, traceId, resumeToken });

    let child: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
    let transport: AcpTransport | null = null;
    let stderrBuf = '';
    const collectedText: string[] = [];
    let activeSessionId: string | undefined;

    const cleanup = async (): Promise<void> => {
      transport?.dispose();
      if (child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
        await waitForExit(child, killGraceMs).catch(() => {
          try {
            child!.kill('SIGKILL');
          } catch {
            // already gone
          }
        });
      }
    };

    const fail = async (err: unknown, reason: 'error' | 'aborted'): Promise<AgentRunResult> => {
      turns.close();
      pushEvent({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: false,
      });
      pushEvent({ type: 'agent_end', source, traceId, reason, resumeToken });
      closeStream();
      hasEnded = true;
      await cleanup();
      return {
        text: collectedText.join(''),
        finishReason: reason,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
        resumeToken,
      };
    };

    try {
      // 1. Spawn subprocess.
      child = spawnAgent(config);

      child.on('error', (err) => {
        pushEvent({
          type: 'error',
          source,
          traceId,
          error: serializeError(err),
          transient: false,
        });
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
        // Cap to avoid unbounded growth on noisy agents.
        if (stderrBuf.length > 16_384) {
          stderrBuf = stderrBuf.slice(-16_384);
        }
        pushEvent({
          type: 'native',
          source,
          traceId,
          kind: 'acp:stderr',
          payload: chunk,
        });
      });

      // 2. Build transport.
      transport = createAcpTransport({
        child,
        onNotification: (method, params) => {
          if (method === ACP_METHODS.sessionUpdate) {
            handleSessionUpdate(params as SessionNotificationParams);
          } else {
            pushEvent({
              type: 'native',
              source,
              traceId,
              kind: `acp:notification:${method}`,
              payload: params,
            });
          }
        },
        onRequest: async (method, params) => {
          if (method === ACP_METHODS.requestPermission) {
            pushEvent({
              type: 'native',
              source,
              traceId,
              kind: 'acp:request_permission',
              payload: params,
            });
            // v1: respond per permissionMode. Real shape per the ACP spec
            // varies by agent; we return a best-effort approval/rejection
            // shape. Adapters that need finer control can wrap this
            // chassis with their own onRequest before we land it as a
            // first-class option.
            return config.permissionMode === 'allow'
              ? { outcome: { outcome: 'selected', optionId: 'allow' } }
              : { outcome: { outcome: 'cancelled' } };
          }
          pushEvent({
            type: 'native',
            source,
            traceId,
            kind: `acp:request:${method}`,
            payload: params,
          });
          throw new Error(`unsupported ACP request: ${method}`);
        },
        onTransportError: (err) => {
          pushEvent({
            type: 'error',
            source,
            traceId,
            error: serializeError(err),
            transient: true,
          });
        },
      });

      // 3. Initialize handshake.
      const initReq: InitializeRequest = {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientInfo: config.clientInfo,
        clientCapabilities: config.clientCapabilities,
      };
      const initRes = await transport.request<InitializeResponse>(
        ACP_METHODS.initialize,
        initReq,
      );
      pushEvent({
        type: 'native',
        source,
        traceId,
        kind: 'acp:initialized',
        payload: initRes,
      });

      if (compositeSignal.aborted) {
        return await fail(new Error('aborted before session creation'), 'aborted');
      }

      // 4. Session creation or resumption.
      const mcpServers = config.mcpServers ?? [];
      if (config.resumeSessionId) {
        if (initRes.agentCapabilities?.loadSession !== true) {
          throw new Error('agent does not declare loadSession capability; cannot resume');
        }
        const loadReq: LoadSessionRequest = {
          sessionId: config.resumeSessionId,
          cwd: config.cwd,
          mcpServers,
        };
        await transport.request<unknown>(ACP_METHODS.loadSession, loadReq);
        activeSessionId = config.resumeSessionId;
      } else {
        const newReq: NewSessionRequest = {
          cwd: config.cwd,
          mcpServers,
        };
        const newRes = await transport.request<NewSessionResponse>(
          ACP_METHODS.newSession,
          newReq,
        );
        activeSessionId = newRes.sessionId;
      }
      resumeToken = { kind: 'opaque', data: activeSessionId };

      if (compositeSignal.aborted) {
        return await fail(new Error('aborted before prompt'), 'aborted');
      }

      // 5. Wire cancel — send session/cancel when the composite aborts.
      let cancelSent = false;
      const sendCancel = (): void => {
        if (cancelSent || !activeSessionId || !transport) return;
        cancelSent = true;
        const params: CancelNotificationParams = { sessionId: activeSessionId };
        try {
          transport.notify(ACP_METHODS.cancel, params);
        } catch {
          // transport may already be down; cleanup handles it
        }
      };
      if (compositeSignal.aborted) {
        sendCancel();
      } else {
        compositeSignal.addEventListener('abort', sendCancel, { once: true });
      }

      // 6. Prompt loop. The first iteration uses config.prompt; subsequent
      // iterations drain followUpQueue (populated by SteerableAgentRun.followUp).
      // Loop exits when the queue is empty after a response, or on abort/error.
      let firstIteration = true;
      let lastFinishReason: AgentRunResult['finishReason'] = 'unknown';

      while (true) {
        let currentPrompt: string | ContentBlock[] | undefined;
        if (firstIteration) {
          currentPrompt = config.prompt;
          firstIteration = false;
        } else {
          currentPrompt = followUpQueue.shift();
        }
        if (currentPrompt === undefined) break;

        const promptBlocks: ContentBlock[] = Array.isArray(currentPrompt)
          ? currentPrompt
          : [{ type: 'text', text: currentPrompt }];
        const promptReq: PromptRequest = {
          sessionId: activeSessionId,
          prompt: promptBlocks,
        };

        let promptRes: PromptResponse;
        try {
          promptRes = await transport.request<PromptResponse>(
            ACP_METHODS.prompt,
            promptReq,
          );
        } catch (err) {
          const aborted = compositeSignal.aborted || cancelSent;
          return await fail(err, aborted ? 'aborted' : 'error');
        }

        // Emit canonical turn_end for this prompt cycle. Natural ordering:
        // text + tool_call events already arrived during the response, so
        // endTurn() emits a turn_end with the accumulated counts immediately.
        turns.endTurn();

        lastFinishReason = mapStopReason(promptRes.stopReason, compositeSignal.aborted);
        if (lastFinishReason === 'aborted') break;
      }

      // 7. Synthesize result. resumeToken at this point points at the
      // (potentially updated) session id.
      turns.close();
      pushEvent({ type: 'agent_end', source, traceId, reason: lastFinishReason, resumeToken });
      closeStream();
      hasEnded = true;
      await cleanup();

      return {
        text: collectedText.join(''),
        finishReason: lastFinishReason,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
        resumeToken,
      };
    } catch (err) {
      const aborted = compositeSignal.aborted;
      return await fail(err, aborted ? 'aborted' : 'error');
    }

    function handleSessionUpdate(params: SessionNotificationParams): void {
      if (!params || typeof params !== 'object' || !('update' in params)) {
        return;
      }
      // params.update is typed as SessionUpdate for known variants. Future
      // or vendor variants arrive with an unrecognized `sessionUpdate` —
      // they hit the `default` branch via a wider runtime check.
      const update = params.update as SessionUpdate & { sessionUpdate: string };
      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = contentBlockToText(update.content);
          collectedText.push(text);
          turns.text(text);
          break;
        }
        case 'agent_thought_chunk': {
          turns.thinking(contentBlockToText(update.content));
          break;
        }
        case 'tool_call': {
          turns.toolCall(
            update.toolCallId,
            update.title ?? update.kind ?? 'tool',
            update.rawInput ?? update.content ?? null,
          );
          break;
        }
        case 'tool_call_update': {
          if (update.status === 'completed') {
            turns.toolResult(
              update.toolCallId,
              update.title ?? 'tool',
              update.rawOutput ?? update.content ?? null,
              false,
            );
          } else if (update.status === 'failed' || update.status === 'cancelled') {
            turns.toolResult(
              update.toolCallId,
              update.title ?? 'tool',
              update.rawOutput ?? update.content ?? null,
              true,
            );
          } else {
            // 'in_progress' / 'pending' — informational; surface as native.
            turns.native(`acp:tool_status:${update.status}`, update);
          }
          break;
        }
        case 'user_message_chunk': {
          // Echo of the client's own prompt; surface as native rather than
          // as a canonical text event (which is reserved for the agent).
          turns.native('acp:user_chunk', update);
          break;
        }
        default: {
          turns.native(`acp:${update.sessionUpdate}`, update);
          break;
        }
      }
    }
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
    /**
     * Queue an additional prompt to send on the same ACP session after
     * the current prompt response completes. Calls before the run starts
     * are honored — the loop drains the queue before exiting. After
     * agent_end the call rejects.
     */
    followUp(message: string): Promise<void> {
      if (hasEnded) {
        return Promise.reject(new Error('cannot followUp after agent_end'));
      }
      followUpQueue.push(message);
      return Promise.resolve();
    },
    /**
     * Mid-stream steering. ACP's `session/prompt` is a discrete request —
     * the protocol doesn't expose mid-generation injection. Callers that
     * need to add a message after the current response should use
     * `followUp()` instead.
     */
    steer(_message: string): Promise<void> {
      return Promise.reject(
        new Error(
          `${source} does not support mid-stream steering; use followUp() to send a message after the current prompt response completes`,
        ),
      );
    },
  } as AgentRun; // SteerableAgentRun at runtime; narrowed via isSteerable() at the call site.
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function spawnAgent(config: AcpAgentConfig): ChildProcessByStdio<Writable, Readable, Readable> {
  const env = config.env ? { ...process.env, ...config.env } : process.env;
  const child = spawn(config.command, config.args ?? [], {
    cwd: config.subprocessCwd ?? config.cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return child as ChildProcessByStdio<Writable, Readable, Readable>;
}

function waitForExit(
  child: ChildProcessByStdio<Writable, Readable, Readable | null>,
  graceMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      child.removeListener('exit', onExit);
      reject(new Error('exit timeout'));
    }, graceMs);
    const onExit = (): void => {
      clearTimeout(t);
      resolve();
    };
    child.once('exit', onExit);
  });
}

function mapStopReason(reason: StopReason, aborted: boolean): AgentRunResult['finishReason'] {
  if (aborted || reason === 'cancelled') return 'aborted';
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'max_turn_requests':
      return 'tool_calls';
    case 'refusal':
      return 'content_filter';
    default:
      return 'unknown';
  }
}

// Re-export the JsonRpcCallError class for callers that catch it.
export { JsonRpcCallError };
