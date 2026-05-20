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
}

export async function runCli(options: RunCliOptions): Promise<number> {
  const cwd = options.cwd ?? process.cwd();
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
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
      return cmdRun(registry, rest, { stdout, stderr });
    case 'serve':
      return cmdServe(registry, { stdout, stderr });
    case 'list':
      return cmdList(registry, { stdout });
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
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
  const name = args[0];
  if (!name) {
    io.stderr.write('usage: thread-phase run <pipeline-name>\n');
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

  const event: TriggerEvent<unknown> = {
    id: 1,
    occurredAt: new Date().toISOString(),
    input: spec.defaultInput,
  };
  const { phases, ctx } = materializePipeline(spec, spec.defaultInput, event);

  io.stdout.write(`[run] ${name}\n`);
  let hadError = false;
  for await (const ev of runPipeline(phases, ctx)) {
    io.stdout.write(`${JSON.stringify(ev)}\n`);
    if (ev.type === 'error') hadError = true;
  }
  return hadError ? 1 : 0;
}

async function cmdServe(
  registry: Registry,
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
): Promise<number> {
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

  const shutdown = async (signal: string): Promise<void> => {
    io.stdout.write(`\n[serve] ${signal} received, shutting down…\n`);
    await Promise.all(handles.map((h) => h.stop()));
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await Promise.all(handles.map((h) => h.done));
  io.stdout.write('[serve] all pipelines exited\n');
  return 0;
}

function cmdList(
  registry: Registry,
  io: { stdout: NodeJS.WritableStream },
): Promise<number> | number {
  const triggers = registry.listTriggers();
  const adapters = registry.listAdapters();
  const pipelines = registry.listPipelines();

  io.stdout.write(`triggers (${triggers.length}):\n`);
  for (const t of triggers) {
    io.stdout.write(`  ${t.name}  (${t.source})\n`);
  }
  io.stdout.write(`\nadapters (${adapters.length}):\n`);
  for (const a of adapters) {
    io.stdout.write(`  ${a.name}  id=${a.id}  (${a.source})\n`);
  }
  io.stdout.write(`\npipelines (${pipelines.length}):\n`);
  for (const p of pipelines) {
    const trigger = p.trigger ? `  trigger=${p.trigger}` : '  one-shot';
    const desc = p.description ? `  — ${p.description}` : '';
    io.stdout.write(`  ${p.name}${trigger}${desc}  (${p.source})\n`);
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
