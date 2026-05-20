/**
 * Concrete registry implementing `ThreadPhaseAPI`.
 *
 * Backed by plain Maps keyed by name. Holds no per-kind type — registered
 * adapters/triggers/pipelines come back as `unknown`-typed values, and
 * the CLI/loader narrows when invoking them. This keeps the registry
 * simple at the cost of some casts at use sites.
 *
 * Name collisions throw with the location of the prior registration so
 * the user can spot the duplicate quickly.
 */

import type {
  AgentAdapterMeta,
  AgentRunResult,
} from '@autonome-research/thread-phase/agents';
import type { BasePipelineContext } from '@autonome-research/thread-phase';
import type { Trigger } from '@autonome-research/thread-phase/triggers';
import type { PipelineSpec, ThreadPhaseAPI } from './types.js';

interface Registered<T> {
  value: T;
  source: string;
}

export class Registry implements ThreadPhaseAPI {
  private readonly triggers = new Map<string, Registered<Trigger<unknown>>>();
  private readonly adapters = new Map<string, Registered<AgentAdapterMeta<unknown, AgentRunResult>>>();
  private readonly pipelines = new Map<string, Registered<PipelineSpec<BasePipelineContext, unknown>>>();

  /**
   * Source path attributed to the next register call. Set by the loader
   * before invoking the extension's default export, cleared after.
   */
  currentSource: string = '<unknown>';

  registerTrigger<TInput>(name: string, trigger: Trigger<TInput>): void {
    const existing = this.triggers.get(name);
    if (existing) {
      throw new Error(
        `duplicate trigger "${name}" registered from ${this.currentSource} (already registered from ${existing.source})`,
      );
    }
    this.triggers.set(name, {
      value: trigger as Trigger<unknown>,
      source: this.currentSource,
    });
  }

  registerAdapter<TConfig, TResult extends AgentRunResult = AgentRunResult>(
    name: string,
    adapter: AgentAdapterMeta<TConfig, TResult>,
  ): void {
    const existing = this.adapters.get(name);
    if (existing) {
      throw new Error(
        `duplicate adapter "${name}" registered from ${this.currentSource} (already registered from ${existing.source})`,
      );
    }
    this.adapters.set(name, {
      value: adapter as unknown as AgentAdapterMeta<unknown, AgentRunResult>,
      source: this.currentSource,
    });
  }

  registerPipeline<TCtx extends BasePipelineContext, TInput = unknown>(
    name: string,
    spec: PipelineSpec<TCtx, TInput>,
  ): void {
    const existing = this.pipelines.get(name);
    if (existing) {
      throw new Error(
        `duplicate pipeline "${name}" registered from ${this.currentSource} (already registered from ${existing.source})`,
      );
    }
    this.pipelines.set(name, {
      value: spec as unknown as PipelineSpec<BasePipelineContext, unknown>,
      source: this.currentSource,
    });
  }

  // --- inspection ---------------------------------------------------------

  getTrigger(name: string): Trigger<unknown> | undefined {
    return this.triggers.get(name)?.value;
  }

  getAdapter(
    name: string,
  ): AgentAdapterMeta<unknown, AgentRunResult> | undefined {
    return this.adapters.get(name)?.value;
  }

  getPipeline(
    name: string,
  ): PipelineSpec<BasePipelineContext, unknown> | undefined {
    return this.pipelines.get(name)?.value;
  }

  listTriggers(): Array<{ name: string; source: string }> {
    return Array.from(this.triggers.entries()).map(([name, r]) => ({
      name,
      source: r.source,
    }));
  }

  listAdapters(): Array<{ name: string; id: string; source: string }> {
    return Array.from(this.adapters.entries()).map(([name, r]) => ({
      name,
      id: r.value.id,
      source: r.source,
    }));
  }

  listPipelines(): Array<{
    name: string;
    trigger?: string;
    description?: string;
    source: string;
  }> {
    return Array.from(this.pipelines.entries()).map(([name, r]) => ({
      name,
      trigger: r.value.trigger,
      description: r.value.description,
      source: r.source,
    }));
  }
}
