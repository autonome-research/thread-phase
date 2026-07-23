/**
 * Local types for the helpers package.
 *
 * These mirror the shapes of `PipelineSpec` and `ThreadPhaseAPI` from
 * `@autonome-research/thread-phase-cli` but are redeclared here so the
 * core package stays free of any dependency on the CLI. The CLI's
 * `Registry` is structurally compatible with this `ThreadPhaseAPI` —
 * the helpers' return value plugs straight into the CLI auto-loader.
 */
import type { AgentAdapterMeta, AgentRunResult } from '../agents/index.js';
import type { BasePipelineContext, Phase } from '../phase.js';
import type { Trigger, TriggerEvent } from '../triggers/types.js';
/** A registered pipeline definition. Structurally identical to the CLI's. */
export interface PipelineSpec<TCtx extends BasePipelineContext = BasePipelineContext, TInput = unknown> {
    phases: ReadonlyArray<Phase<TCtx>> | ((input: TInput, event: TriggerEvent<TInput>) => ReadonlyArray<Phase<TCtx>>);
    ctx: TCtx | ((input: TInput, event: TriggerEvent<TInput>) => TCtx);
    trigger?: string;
    defaultInput?: TInput;
    description?: string;
}
/** Registration surface a helper invokes. Structurally compatible with the CLI's `ThreadPhaseAPI`. */
export interface ThreadPhaseAPI {
    registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void;
    registerAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(name: string, adapter: AgentAdapterMeta<TConfig, TResult>): void;
    registerPipeline<TCtx extends BasePipelineContext, TInput = unknown>(name: string, spec: PipelineSpec<TCtx, TInput>): void;
    getPipeline(name: string): PipelineSpec<BasePipelineContext, unknown> | undefined;
    getAdapter(name: string): AgentAdapterMeta<unknown, AgentRunResult> | undefined;
    getTrigger(name: string): Trigger<unknown> | undefined;
}
/** Extension default export: `(api) => void`. */
export type ExtensionRegisterFn = (api: ThreadPhaseAPI) => void | Promise<void>;
/** A user-supplied handler wrapped by a helper into a Phase. */
export type HelperHandler<TInput, TResult> = (input: TInput, ctx: BasePipelineContext) => Promise<TResult> | TResult;
//# sourceMappingURL=types.d.ts.map