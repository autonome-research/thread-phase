/**
 * Claude Code adapter — wraps the `claude` CLI in stream-json mode.
 *
 * Spawns the CLI, parses NDJSON output, translates known event shapes
 * to canonical AgentEvents, and surfaces unknown shapes as native
 * events. The Claude Code CLI surface changes with releases — the
 * adapter is forgiving by design: unrecognized lines become
 * `native { kind: 'claude-code:<type>' }` events rather than errors.
 *
 * Default invocation:
 *   claude --print --output-format stream-json --verbose [<prompt>]
 *
 * With `resumeSessionId`:
 *   claude --print --output-format stream-json --verbose --resume <id> [<prompt>]
 *
 * Override `claudeArgs` to take full control of argv when the CLI
 * version on PATH expects a different shape.
 *
 * Capabilities:
 *   streaming        'text'
 *   cancellation     'forceful'
 *   resumption       'opaque'      (session id as the resume token)
 *   structuredOutput 'prompted'
 *
 * @internal
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

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

const ADAPTER_ID = 'claude-code';

/** @internal */
export interface ClaudeCodeAgentConfig {
  /** Working directory passed as the subprocess cwd. */
  cwd: string;
  /** Prompt sent to the agent. Becomes the trailing positional arg by default. */
  prompt: string;
  /** Executable. Default 'claude'. */
  claudeExecutable?: string;
  /**
   * Full argv override. When set, takes precedence over all defaults
   * including --print, --output-format, --resume, and the prompt
   * positional. Useful when wrapping a different CLI version.
   */
  claudeArgs?: string[];
  /**
   * Resume a prior session by id. Adds `--resume <id>` to the default
   * args (ignored if `claudeArgs` is set).
   */
  resumeSessionId?: string;
  /** Environment overrides merged with process.env. */
  env?: Record<string, string>;
  /** SIGTERM-then-SIGKILL grace in ms; default 3000. */
  killGraceMs?: number;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const claudeCodeAgent: AgentAdapterMeta<ClaudeCodeAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'forceful',
    resumption: 'opaque',
    structuredOutput: 'prompted',
  },
  adapter: createClaudeCodeAdapter,
});

function createClaudeCodeAdapter(
  config: ClaudeCodeAgentConfig,
  options: AgentRunOptions = {},
): AgentRun {
  const source = ADAPTER_ID;
  const traceId = options.traceId;
  const killGraceMs = config.killGraceMs ?? 3000;

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
    let resumeToken: ResumeToken | undefined = config.resumeSessionId
      ? { kind: 'opaque', data: config.resumeSessionId }
      : undefined;
    queue.push({ type: 'agent_start', source, traceId, resumeToken });

    const effectivePrompt = config.outputSchema
      ? `${config.prompt}\n\n${applyStructuredOutputPrompt('', config.outputSchema)}`
      : config.prompt;

    const args = config.claudeArgs ?? buildDefaultArgs(effectivePrompt, config.resumeSessionId);
    const env = config.env ? { ...process.env, ...config.env } : process.env;
    const executable = config.claudeExecutable ?? 'claude';

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(executable, args, {
        cwd: config.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
    } catch (err) {
      turns.close();
      queue.push({
        type: 'error',
        source,
        traceId,
        error: serializeError(err),
        transient: false,
      });
      queue.push({ type: 'agent_end', source, traceId, reason: 'error', resumeToken });
      queue.close();
      return {
        text: '',
        finishReason: 'error',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        executedToolCalls: [],
        resumeToken,
      };
    }

    let stdoutBuf = '';
    let assembledText = '';
    let sessionId: string | undefined = config.resumeSessionId;
    const executedToolCalls: ToolCall[] = [];

    const parseLine = (line: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        turns.native('claude-code:non-json', line);
        return;
      }
      if (msg === null || typeof msg !== 'object') {
        turns.native('claude-code:non-object', msg);
        return;
      }
      handleMessage(msg as Record<string, unknown>);
    };

    const handleMessage = (msg: Record<string, unknown>): void => {
      const type = typeof msg.type === 'string' ? msg.type : 'unknown';
      // Capture session_id whenever it surfaces.
      const sid = typeof msg.session_id === 'string' ? msg.session_id : undefined;
      if (sid) {
        sessionId = sid;
        resumeToken = { kind: 'opaque', data: sid };
      }

      if (type === 'system') {
        // init / config / etc — surface as native; session_id already captured.
        turns.native(`claude-code:system:${msg.subtype ?? 'unknown'}`, msg);
        return;
      }

      if (type === 'assistant') {
        const message = msg.message as { content?: unknown } | undefined;
        const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
        for (const raw of content) {
          if (raw === null || typeof raw !== 'object') continue;
          const block = raw as Record<string, unknown>;
          const blockType = typeof block.type === 'string' ? block.type : 'unknown';
          if (blockType === 'text' && typeof block.text === 'string') {
            assembledText += block.text;
            turns.text(block.text);
          } else if (blockType === 'thinking' && typeof block.thinking === 'string') {
            turns.thinking(block.thinking);
          } else if (blockType === 'tool_use') {
            const id = typeof block.id === 'string' ? block.id : `tu_${executedToolCalls.length}`;
            const name = typeof block.name === 'string' ? block.name : 'tool';
            const input = (typeof block.input === 'object' && block.input !== null && !Array.isArray(block.input))
              ? (block.input as Record<string, unknown>)
              : {};
            turns.toolCall(id, name, input);
            executedToolCalls.push({ id, name, input });
          } else {
            turns.native(`claude-code:assistant-block:${blockType}`, block);
          }
        }
        return;
      }

      if (type === 'user') {
        const message = msg.message as { content?: unknown } | undefined;
        const content = Array.isArray(message?.content) ? (message?.content as unknown[]) : [];
        for (const raw of content) {
          if (raw === null || typeof raw !== 'object') continue;
          const block = raw as Record<string, unknown>;
          if (block.type === 'tool_result') {
            const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
            const isError = block.is_error === true;
            const out = block.content ?? null;
            turns.toolResult(id, 'tool', out, isError);
          } else {
            turns.native(`claude-code:user-block:${block.type ?? 'unknown'}`, block);
          }
        }
        return;
      }

      if (type === 'result') {
        // Final summary. Captured as native; the close-handler synthesizes
        // the canonical agent_end based on exit code + collected text.
        turns.native('claude-code:result', msg);
        return;
      }

      turns.native(`claude-code:${type}`, msg);
    };

    const onAbortSignal = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, killGraceMs);
    };
    if (compositeSignal.aborted) {
      onAbortSignal();
    } else {
      compositeSignal.addEventListener('abort', onAbortSignal, { once: true });
    }

    return new Promise<AgentRunResult>((resolve) => {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl);
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (line.trim().length > 0) parseLine(line);
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        queue.push({
          type: 'native',
          source,
          traceId,
          kind: 'claude-code:stderr',
          payload: chunk,
        });
      });

      child.on('error', (err) => {
        queue.push({
          type: 'error',
          source,
          traceId,
          error: serializeError(err),
          transient: false,
        });
      });

      child.on('close', (code, signal) => {
        if (stdoutBuf.trim().length > 0) parseLine(stdoutBuf.trim());
        turns.close();

        const aborted = compositeSignal.aborted;
        let finishReason: AgentRunResult['finishReason'];
        if (aborted) finishReason = 'aborted';
        else if (code === 0) finishReason = executedToolCalls.length > 0 ? 'tool_calls' : 'stop';
        else finishReason = 'error';

        // Non-zero exit with no prior 'error' event would leave the
        // event stream without a diagnostic. Synthesize one — the
        // conformance suite asserts an error event precedes agent_end
        // on the error path, and consumers expect to see why the run
        // failed without combing through native stderr events.
        if (finishReason === 'error') {
          queue.push({
            type: 'error',
            source,
            traceId,
            error: {
              name: 'ClaudeCodeExitError',
              message: signal
                ? `claude-code exited via signal ${signal}`
                : `claude-code exited with code ${code ?? 'null'}`,
            },
            transient: false,
          });
        }

        if (sessionId) {
          resumeToken = { kind: 'opaque', data: sessionId };
        }

        let parsed: unknown = undefined;
        let parseError: SerializableError | undefined = undefined;
        if (config.outputSchema && finishReason === 'stop') {
          try {
            parsed = parseStructuredFromText(assembledText, config.outputSchema);
          } catch (err) {
            parseError = serializeError(err);
          }
        }

        queue.push({ type: 'agent_end', source, traceId, reason: finishReason, resumeToken });
        queue.close();

        resolve({
          text: assembledText,
          finishReason,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          executedToolCalls,
          parsed,
          parseError,
          resumeToken,
        });
      });
    });
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

function buildDefaultArgs(prompt: string, resumeSessionId?: string): string[] {
  const args = ['--print', '--output-format', 'stream-json', '--verbose'];
  if (resumeSessionId) {
    args.push('--resume', resumeSessionId);
  }
  args.push(prompt);
  return args;
}
