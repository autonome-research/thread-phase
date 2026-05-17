/**
 * Codex CLI adapter — subprocess wrapper around `codex exec --json`.
 *
 * Why this exists alongside `codexAgent`: that adapter talks to OpenAI's
 * Responses API directly via the SDK and needs `OPENAI_API_KEY`. The
 * Codex CLI carries its own ChatGPT-subscription OAuth flow (`~/.codex/`),
 * so users who installed `codex` and ran `codex login` already have a
 * working agent without an API key. This adapter delegates auth and
 * model selection entirely to the CLI; we just parse its NDJSON output
 * stream into canonical AgentEvents.
 *
 * Capabilities:
 *   streaming        'text'
 *   cancellation     'forceful'
 *   resumption       'opaque'      (codex thread id)
 *   structuredOutput 'prompted'
 *
 * The CLI's `--json` event vocabulary is higher-level than the raw
 * Responses API stream:
 *   thread.started        -> capture thread_id as resumeToken
 *   turn.started          -> (informational, surfaced as native)
 *   item.started type=command_execution
 *                         -> tool_call event
 *   item.completed type=command_execution
 *                         -> tool_result event (isError from exit_code)
 *   item.completed type=agent_message
 *                         -> text event with item.text
 *   item.completed type=reasoning
 *                         -> thinking event
 *   turn.completed        -> turn_end with usage
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

const ADAPTER_ID = 'codex-cli';

/** @internal */
export interface CodexCliAgentConfig {
  /** Working directory passed via `--cd`. */
  cwd: string;
  /** Prompt sent as the positional argument to `codex exec`. */
  prompt: string;
  /**
   * Resume a prior codex thread by id. When set, invokes
   * `codex exec resume <id>` instead of `codex exec`.
   */
  resumeThreadId?: string;
  /** Executable; default 'codex'. */
  codexExecutable?: string;
  /**
   * Full argv override. When set, takes precedence over the default
   * argument layout (--json --skip-git-repo-check etc.) — useful when
   * the CLI version on PATH differs.
   */
  codexArgs?: string[];
  /** Model override (`codex exec -m <model>`). */
  model?: string;
  /**
   * Sandbox policy passed via `-s`. Default 'read-only' (safest); set
   * to 'workspace-write' or 'danger-full-access' for tool-using runs.
   */
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  /** Environment overrides merged with process.env. */
  env?: Record<string, string>;
  /** SIGTERM-then-SIGKILL grace in ms; default 3000. */
  killGraceMs?: number;
  /** Optional structured-output spec (prompted path). */
  outputSchema?: StructuredOutputConfig;
}

/** @internal */
export const codexCliAgent: AgentAdapterMeta<CodexCliAgentConfig> = defineAgentAdapter({
  id: ADAPTER_ID,
  capabilities: {
    streaming: 'text',
    cancellation: 'forceful',
    resumption: 'opaque',
    structuredOutput: 'prompted',
  },
  adapter: createCodexCliAdapter,
});

function createCodexCliAdapter(
  config: CodexCliAgentConfig,
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
    let resumeToken: ResumeToken | undefined = config.resumeThreadId
      ? { kind: 'opaque', data: config.resumeThreadId }
      : undefined;
    queue.push({ type: 'agent_start', source, traceId, resumeToken });

    const effectivePrompt = config.outputSchema
      ? `${config.prompt}\n\n${applyStructuredOutputPrompt('', config.outputSchema)}`
      : config.prompt;

    const args = config.codexArgs ?? buildDefaultArgs(config, effectivePrompt);
    const env = config.env ? { ...process.env, ...config.env } : process.env;
    const executable = config.codexExecutable ?? 'codex';

    let child: ChildProcessByStdio<Writable, Readable, Readable>;
    try {
      child = spawn(executable, args, {
        cwd: config.cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessByStdio<Writable, Readable, Readable>;
      // codex reads stdin if no prompt arg is on the cmdline; close it
      // so the subprocess doesn't hang waiting.
      child.stdin.end();
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
    let threadId: string | undefined = config.resumeThreadId;
    let inputTokens = 0;
    let outputTokens = 0;
    const executedToolCalls: ToolCall[] = [];
    const pendingTools = new Map<string, { name: string; input: unknown }>();

    const parseLine = (line: string): void => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        turns.native('codex-cli:non-json', line);
        return;
      }
      if (msg === null || typeof msg !== 'object') {
        turns.native('codex-cli:non-object', msg);
        return;
      }
      handleMessage(msg as Record<string, unknown>);
    };

    const handleMessage = (msg: Record<string, unknown>): void => {
      const type = typeof msg.type === 'string' ? msg.type : 'unknown';

      if (type === 'thread.started') {
        const tid = typeof msg.thread_id === 'string' ? msg.thread_id : undefined;
        if (tid) {
          threadId = tid;
          resumeToken = { kind: 'opaque', data: tid };
        }
        turns.native('codex-cli:thread_started', msg);
        return;
      }

      if (type === 'turn.started') {
        turns.native('codex-cli:turn_started', msg);
        return;
      }

      if (type === 'turn.completed') {
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage) {
          const input = Number(usage.input_tokens) || 0;
          const output = Number(usage.output_tokens) || 0;
          inputTokens += input;
          outputTokens += output;
        }
        turns.endTurn(
          usage
            ? {
                promptTokens: Number(usage.input_tokens) || 0,
                completionTokens: Number(usage.output_tokens) || 0,
                totalTokens: (Number(usage.input_tokens) || 0) + (Number(usage.output_tokens) || 0),
              }
            : undefined,
        );
        return;
      }

      if (type === 'item.started' || type === 'item.completed') {
        const item = (msg.item ?? {}) as Record<string, unknown>;
        const itemType = typeof item.type === 'string' ? item.type : 'unknown';
        const itemId = typeof item.id === 'string' ? item.id : `codex-${pendingTools.size}`;

        if (itemType === 'command_execution') {
          const command = typeof item.command === 'string' ? item.command : '';
          if (type === 'item.started') {
            const input = { command };
            pendingTools.set(itemId, { name: 'shell', input });
            turns.toolCall(itemId, 'shell', input);
          } else {
            // completed
            const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
            const exitCode = typeof item.exit_code === 'number' ? item.exit_code : null;
            const isError = exitCode !== null && exitCode !== 0;
            turns.toolResult(itemId, 'shell', output, isError);
            const tool = pendingTools.get(itemId);
            if (tool) {
              executedToolCalls.push({ id: itemId, name: tool.name, input: tool.input as Record<string, unknown> });
              pendingTools.delete(itemId);
            }
          }
          return;
        }

        if (itemType === 'agent_message' && type === 'item.completed') {
          const text = typeof item.text === 'string' ? item.text : '';
          if (text) {
            assembledText += text;
            turns.text(text);
          }
          return;
        }

        if (itemType === 'reasoning' && type === 'item.completed') {
          const text = typeof item.text === 'string' ? item.text : '';
          if (text) turns.thinking(text);
          return;
        }

        if (itemType === 'function_call' && type === 'item.completed') {
          const name = typeof item.name === 'string' ? item.name : 'function';
          const rawInput = item.arguments ?? item.input ?? {};
          const parsed = typeof rawInput === 'string'
            ? safeParseJson(rawInput)
            : (rawInput as Record<string, unknown>);
          turns.toolCall(itemId, name, parsed);
          executedToolCalls.push({ id: itemId, name, input: parsed });
          return;
        }

        // Unknown item type — surface as native.
        turns.native(`codex-cli:item:${itemType}`, msg);
        return;
      }

      turns.native(`codex-cli:${type}`, msg);
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
          kind: 'codex-cli:stderr',
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

        if (finishReason === 'error') {
          queue.push({
            type: 'error',
            source,
            traceId,
            error: {
              name: 'CodexCliExitError',
              message: signal
                ? `codex exited via signal ${signal}`
                : `codex exited with code ${code ?? 'null'}`,
            },
            transient: false,
          });
        }

        if (threadId) {
          resumeToken = { kind: 'opaque', data: threadId };
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
          usage: {
            promptTokens: inputTokens,
            completionTokens: outputTokens,
            totalTokens: inputTokens + outputTokens,
          },
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

function buildDefaultArgs(config: CodexCliAgentConfig, prompt: string): string[] {
  const args: string[] = ['exec', '--json', '--skip-git-repo-check'];
  if (config.sandbox) args.push('-s', config.sandbox);
  else args.push('-s', 'read-only');
  if (config.model) args.push('-m', config.model);
  if (config.resumeThreadId) {
    args.push('resume', config.resumeThreadId, prompt);
  } else {
    args.push(prompt);
  }
  return args;
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(s);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { _rawJson: s };
  } catch {
    return { _rawJson: s };
  }
}
