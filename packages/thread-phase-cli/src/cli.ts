/**
 * CLI subcommand dispatcher.
 *
 * Three subcommands:
 *   - `run <name>`     execute a registered pipeline once, exit
 *   - `serve`          start all triggered pipelines, run continuously
 *   - `list`           print everything in the registry, grouped by kind
 *
 * All commands first call `loadExtensions(...)` against `${cwd}/.thread-phase/`,
 * then dispatch against the populated registry.
 */

import { PipelineCache, runPipeline } from '@autonome-research/thread-phase';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import { runTrigger } from '@autonome-research/thread-phase/triggers';
import type {
  Trigger,
  TriggerEvent,
} from '@autonome-research/thread-phase/triggers';

import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

import { Registry } from './registry.js';
import { loadExtensions } from './loader.js';
import type { PipelineSpec } from './types.js';

export interface RunCliOptions {
  /** Project root. Default: process.cwd(). */
  cwd?: string;
  /** argv excluding `node` and bin script path. */
  args: string[];
  /** Output stream for human-facing logs. Default: process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Error stream. Default: process.stderr. */
  stderr?: NodeJS.WritableStream;
  /**
   * Input stream used when `run --input -` reads JSON from stdin. Optional;
   * defaults to `process.stdin`. Exposed for testability.
   */
  stdin?: NodeJS.ReadableStream;
  /**
   * Optional AbortSignal that, when aborted, initiates the same shutdown
   * path as SIGINT/SIGTERM for `serve`. Exposed for testability.
   */
  abortSignal?: AbortSignal;
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const stdin = options.stdin ?? process.stdin;
  const args = options.args;

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp(stdout);
    return 0;
  }

  const subcommand = args[0];
  const rest = args.slice(1);

  const registry = new Registry();
  await loadExtensions(registry, {
    cwd,
    log: (msg) => stderr.write(`${msg}\n`),
  });

  switch (subcommand) {
    case 'run':
      return cmdRun(registry, rest, { stdout, stderr, stdin });
    case 'serve':
      return cmdServe(registry, rest, {
        stdout,
        stderr,
        abortSignal: options.abortSignal,
      });
    case 'list':
      return cmdList(registry, rest, { stdout });
    default:
      stderr.write(`unknown subcommand: ${subcommand}\n`);
      printHelp(stderr);
      return 1;
  }
}

function printHelp(out: NodeJS.WritableStream): void {
  out.write(`thread-phase — automation workflow runner

Usage:
  thread-phase run <pipeline-name>
  thread-phase serve
  thread-phase list

Discovers extensions from ./.thread-phase/{triggers,adapters,pipelines}/.

Commands:
  run    Execute a registered pipeline once and exit.
  serve  Start all triggered pipelines and run continuously (SIGINT/SIGTERM to stop).
  list   Print the registry: triggers, adapters, pipelines.
`);
}

async function cmdRun(
  registry: Registry,
  args: string[],
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    stdin: NodeJS.ReadableStream;
  },
): Promise<number> {
  // Find the first positional (pipeline name), and an optional --input value.
  let name: string | undefined;
  let inputArg: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--input') {
      inputArg = args[++i];
      continue;
    }
    if (a.startsWith('--input=')) {
      inputArg = a.slice('--input='.length);
      continue;
    }
    if (name === undefined) name = a;
  }

  if (!name) {
    io.stderr.write('usage: thread-phase run <pipeline-name> [--input <json|@file|->]\n');
    return 1;
  }

  const spec = registry.getPipeline(name);
  if (!spec) {
    io.stderr.write(`no pipeline registered with name "${name}"\n`);
    const available = registry.listPipelines().map((p) => p.name);
    if (available.length > 0) {
      io.stderr.write(`available: ${available.join(', ')}\n`);
    }
    return 1;
  }

  let input: unknown = spec.defaultInput;
  if (inputArg !== undefined) {
    try {
      input = await resolveInput(inputArg, io.stdin);
    } catch (err) {
      io.stderr.write(
        `invalid --input: ${(err as Error).message}\n`,
      );
      return 1;
    }
  }

  const event: TriggerEvent<unknown> = {
    id: 1,
    occurredAt: new Date().toISOString(),
    input,
  };
  const { phases, ctx } = materializePipeline(spec, input, event);

  io.stdout.write(`[run] ${name}\n`);
  let hadError = false;
  for await (const ev of runPipeline(phases, ctx)) {
    io.stdout.write(`${JSON.stringify(ev)}\n`);
    if (ev.type === 'error') hadError = true;
  }
  return hadError ? 1 : 0;
}

/**
 * Resolve a `--input` flag value into a parsed JSON value.
 *
 *   - `-`         → read all of stdin, parse as JSON
 *   - `@path`     → read file at path, parse as JSON
 *   - otherwise   → parse the literal arg as JSON
 *
 * Throws `Error` with a human-readable message on parse / IO failure.
 */
async function resolveInput(
  arg: string,
  stdin: NodeJS.ReadableStream,
): Promise<unknown> {
  let raw: string;
  if (arg === '-') {
    raw = await readAll(stdin);
  } else if (arg.startsWith('@')) {
    const path = arg.slice(1);
    try {
      raw = readFileSync(path, 'utf8');
    } catch (err) {
      throw new Error(`could not read file ${path}: ${(err as Error).message}`);
    }
  } else {
    raw = arg;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`not valid JSON (${(err as Error).message})`);
  }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function cmdServe(
  registry: Registry,
  args: string[],
  io: {
    stdout: NodeJS.WritableStream;
    stderr: NodeJS.WritableStream;
    abortSignal?: AbortSignal;
  },
): Promise<number> {
  // Parse flags: --health-port <n> | --health-port=<n>
  let healthPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a === '--health-port') {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        io.stderr.write(`invalid --health-port: ${v}\n`);
        return 1;
      }
      healthPort = n;
      continue;
    }
    if (a.startsWith('--health-port=')) {
      const v = a.slice('--health-port='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) {
        io.stderr.write(`invalid --health-port: ${v}\n`);
        return 1;
      }
      healthPort = n;
      continue;
    }
  }

  const pipelines = registry
    .listPipelines()
    .filter((p) => p.trigger !== undefined);

  if (pipelines.length === 0) {
    io.stderr.write(
      'no triggered pipelines registered — nothing for `serve` to do\n',
    );
    return 1;
  }

  const handles: Array<{ name: string; stop: () => Promise<void>; done: Promise<void> }> = [];
  for (const meta of pipelines) {
    const spec = registry.getPipeline(meta.name)!;
    const trigger = registry.getTrigger(spec.trigger!);
    if (!trigger) {
      io.stderr.write(
        `pipeline "${meta.name}" references trigger "${spec.trigger}" which is not registered — skipping\n`,
      );
      continue;
    }

    io.stdout.write(`[serve] ${meta.name} ← ${spec.trigger}\n`);

    const handle = runTrigger(
      trigger as Trigger<unknown>,
      (input, event) => materializePipeline(spec, input, event),
      {
        pipelineName: meta.name,
        onStart: (event) =>
          io.stdout.write(
            `[start] ${meta.name} event=${event.id} at=${event.occurredAt}\n`,
          ),
        onComplete: (event) =>
          io.stdout.write(`[done]  ${meta.name} event=${event.id}\n`),
        onError: (event, err) =>
          io.stderr.write(
            `[err]   ${meta.name} event=${event.id}: ${err.message}\n`,
          ),
      },
    );
    handles.push({ name: meta.name, stop: handle.stop, done: handle.done });
  }

  if (handles.length === 0) {
    return 1;
  }

  // Optional health-check HTTP server. Returns 200/`ok` while running,
  // 503/`shutting_down` once stop() has begun.
  let healthServer: Server | undefined;
  let serving = true;
  if (healthPort !== undefined) {
    healthServer = createServer((_req, res) => {
      if (serving) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.statusCode = 503;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ status: 'shutting_down' }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      healthServer!.once('error', reject);
      healthServer!.listen(healthPort, '127.0.0.1', () => resolve());
    });
    io.stdout.write(`[serve] health endpoint http://127.0.0.1:${healthPort}/\n`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    serving = false;
    io.stdout.write(`\n[serve] ${signal} received, shutting down…\n`);
    await Promise.all(handles.map((h) => h.stop()));
  };

  const onSigint = () => void shutdown('SIGINT');
  const onSigterm = () => void shutdown('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  const onAbort = () => void shutdown('abort');
  io.abortSignal?.addEventListener('abort', onAbort);

  try {
    await Promise.all(handles.map((h) => h.done));
  } finally {
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    io.abortSignal?.removeEventListener('abort', onAbort);
    if (healthServer) {
      await new Promise<void>((resolve) => healthServer!.close(() => resolve()));
    }
  }
  io.stdout.write('[serve] all pipelines exited\n');
  return 0;
}

function cmdList(
  registry: Registry,
  args: string[],
  io: { stdout: NodeJS.WritableStream },
): Promise<number> | number {
  const verbose = args.includes('--verbose') || args.includes('-v');
  const triggers = registry.listTriggers();
  const adapters = registry.listAdapters();
  const pipelines = registry.listPipelines();

  io.stdout.write(`triggers (${triggers.length}):\n`);
  for (const t of triggers) {
    io.stdout.write(`  ${t.name}  (${t.source})\n`);
    if (verbose) {
      const inst = registry.getTrigger(t.name);
      const className = inst ? inst.constructor.name : 'unknown';
      io.stdout.write(`    source: ${t.source}\n`);
      io.stdout.write(`    class:  ${className}\n`);
    }
  }
  io.stdout.write(`\nadapters (${adapters.length}):\n`);
  for (const a of adapters) {
    io.stdout.write(`  ${a.name}  id=${a.id}  (${a.source})\n`);
    if (verbose) {
      const inst = registry.getAdapter(a.name);
      const caps = inst?.capabilities
        ? JSON.stringify(inst.capabilities)
        : '<none>';
      io.stdout.write(`    id:           ${a.id}\n`);
      io.stdout.write(`    source:       ${a.source}\n`);
      io.stdout.write(`    capabilities: ${caps}\n`);
    }
  }
  io.stdout.write(`\npipelines (${pipelines.length}):\n`);
  for (const p of pipelines) {
    const trigger = p.trigger ? `  trigger=${p.trigger}` : '  one-shot';
    const desc = p.description ? `  — ${p.description}` : '';
    io.stdout.write(`  ${p.name}${trigger}${desc}  (${p.source})\n`);
    if (verbose) {
      const spec = registry.getPipeline(p.name);
      io.stdout.write(`    source:       ${p.source}\n`);
      io.stdout.write(
        `    description:  ${p.description ?? '<none>'}\n`,
      );
      io.stdout.write(
        `    trigger:      ${p.trigger ?? '<one-shot>'}\n`,
      );
      const phasesKind =
        spec && typeof spec.phases === 'function' ? 'factory' : 'array';
      const ctxKind =
        spec && typeof spec.ctx === 'function' ? 'factory' : 'literal';
      io.stdout.write(`    phases:       ${phasesKind}\n`);
      io.stdout.write(`    ctx:          ${ctxKind}\n`);
      const di =
        spec && 'defaultInput' in spec && spec.defaultInput !== undefined
          ? JSON.stringify(spec.defaultInput)
          : '<none>';
      io.stdout.write(`    defaultInput: ${di}\n`);
    }
  }

  return 0;
}

// ---------------------------------------------------------------------------

function materializePipeline<TCtx extends BasePipelineContext, TInput>(
  spec: PipelineSpec<TCtx, TInput>,
  input: TInput,
  event: TriggerEvent<TInput>,
): { phases: ReadonlyArray<Phase<TCtx>>; ctx: TCtx } {
  const phases =
    typeof spec.phases === 'function'
      ? (spec.phases as (i: TInput, e: TriggerEvent<TInput>) => ReadonlyArray<Phase<TCtx>>)(
          input,
          event,
        )
      : spec.phases;

  const ctx =
    typeof spec.ctx === 'function'
      ? (spec.ctx as (i: TInput, e: TriggerEvent<TInput>) => TCtx)(input, event)
      : spec.ctx;

  // Ensure ctx has a fresh cache if the user didn't supply one.
  if (!ctx.cache) {
    (ctx as { cache: PipelineCache }).cache = new PipelineCache();
  }

  return { phases, ctx };
}
