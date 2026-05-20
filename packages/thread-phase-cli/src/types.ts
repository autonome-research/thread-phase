/**
 * Extension contract for the thread-phase CLI auto-loader.
 *
 * Every extension is a TypeScript file (or folder, see loader.ts) whose
 * default export is a function `(api: ThreadPhaseAPI) => void` that
 * calls `api.register{Trigger,Adapter,Pipeline}` to add itself to the
 * project's registry.
 *
 * Patterns are NOT auto-loaded. They are reusable factory functions
 * the user imports directly into their pipeline files. The CLI does
 * not gate access to them.
 */

import type {
  AgentAdapterMeta,
  AgentRunResult,
} from '@autonome-research/thread-phase/agents';
import type {
  BasePipelineContext,
  Phase,
} from '@autonome-research/thread-phase';
import type { Trigger, TriggerEvent } from '@autonome-research/thread-phase/triggers';

/**
 * One registered pipeline. Either:
 *
 * - **Triggered:** bind to a registered trigger by name. `serve` will
 *   run this pipeline on every event from that trigger. `run <name>`
 *   invokes it once with default input (the user-supplied default, or
 *   `undefined` if absent).
 *
 * - **One-shot:** no trigger binding. Only invokable via `run <name>`.
 *
 * `phases` and `ctx` accept either a literal value or a factory that
 * receives the trigger input + event. The factory form is required when
 * ctx needs the input baked in.
 */
export interface PipelineSpec<
  TCtx extends BasePipelineContext = BasePipelineContext,
  TInput = unknown,
> {
  /** Phases to run, or a factory that builds them per invocation. */
  phases:
    | ReadonlyArray<Phase<TCtx>>
    | ((input: TInput, event: TriggerEvent<TInput>) => ReadonlyArray<Phase<TCtx>>);
  /** Initial ctx, or a factory that builds it per invocation. */
  ctx: TCtx | ((input: TInput, event: TriggerEvent<TInput>) => TCtx);
  /** Name of a registered trigger to bind to. Optional. */
  trigger?: string;
  /** Default input used when `run <name>` is invoked without a trigger event. */
  defaultInput?: TInput;
  /** Free-form description for `list`. */
  description?: string;
}

/**
 * The registration API injected into every extension's default export.
 *
 * Registrations live for the lifetime of one CLI invocation. The CLI
 * scans, loads, registers everything, then dispatches `run` / `serve` /
 * `list` against the populated registry.
 *
 * Name collisions are an error — the loader will reject the second
 * registration with a clear message naming both files. Use the file
 * path as the de facto namespace for now.
 */
export interface ThreadPhaseAPI {
  /** Register a Trigger by name. */
  registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void;
  /** Register an AgentAdapter (with its metadata) by name. */
  registerAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(
    name: string,
    adapter: AgentAdapterMeta<TConfig, TResult>,
  ): void;
  /** Register a Pipeline by name. */
  registerPipeline<TCtx extends BasePipelineContext, TInput = unknown>(
    name: string,
    spec: PipelineSpec<TCtx, TInput>,
  ): void;
}

/** Extension default export: `(api) => void`. */
export type ExtensionRegisterFn = (api: ThreadPhaseAPI) => void | Promise<void>;
