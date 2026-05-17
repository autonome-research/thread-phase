/**
 * Bridge `AgentEventBus` → `JobStore` for pipelines that want every
 * adapter event persisted to the job event log.
 *
 * Without this bridge, JobStore captures pipeline-level events (the
 * `PipelineEvent` stream from each phase) but adapter-level events
 * — text deltas, tool calls, thinking, native — flow only through
 * the bus and are lost when the run ends. Callers writing this glue
 * by hand would reach for `bus.on((event) => store.appendEvent(...))`;
 * this helper ships the canonical version with a clean unsubscribe.
 *
 * @internal
 */

import type { PipelineEvent } from '../phase.js';
import type { JobStore } from '../session/index.js';
import type { AgentEvent, AgentEventBus } from './protocol.js';

/** @internal */
export interface PipeAgentEventsOptions {
  /**
   * Event types to drop rather than persist. Useful for high-volume
   * `text` deltas that would balloon the event log. Default: persist
   * everything.
   */
  dropTypes?: ReadonlyArray<AgentEvent['type']>;
  /**
   * Override the `key` written on each appended `PipelineEvent`. By
   * default, `agent:<source>:<type>` so consumers reading the log
   * can filter by source or type. Set to a fixed string when you
   * want all adapter events to share one key.
   */
  key?: string | ((event: AgentEvent) => string);
}

/**
 * Subscribe to a bus and append every agent event to the JobStore
 * under the given job id. Returns an unsubscribe function — call it
 * when the job ends so the bus doesn't retain the store reference.
 *
 * Adapter events are wrapped in a `PipelineEvent` of type `'data'`
 * (the JobStore's escape hatch for arbitrary payloads); the canonical
 * `AgentEvent` is the `value`.
 *
 * @internal
 */
export function pipeAgentEventsToJobStore(
  bus: AgentEventBus,
  store: JobStore,
  jobId: string,
  options: PipeAgentEventsOptions = {},
): () => void {
  const dropTypes = new Set(options.dropTypes ?? []);
  const keyFn = typeof options.key === 'function'
    ? options.key
    : options.key !== undefined
      ? () => options.key as string
      : (event: AgentEvent): string => `agent:${event.source}:${event.type}`;

  return bus.on((event) => {
    if (dropTypes.has(event.type)) return;
    const pipelineEvent: PipelineEvent = {
      type: 'data',
      key: keyFn(event),
      value: event,
    };
    try {
      store.appendEvent(jobId, pipelineEvent);
    } catch {
      // JobStore append failures shouldn't poison the bus.
      // Callers wanting failure visibility should subscribe a
      // separate logging handler.
    }
  });
}
