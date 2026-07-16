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
 */

import type { PipelineEvent } from '../phase.js';
import type { JobStore } from '../session/index.js';
import type { AgentEvent, AgentEventBus } from './protocol.js';
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

export type AgentEventPersistenceFailureKind = 'append' | 'overflow';

/** A persistence failure reported by {@link createAgentEventPersistenceBridge}. */
export interface AgentEventPersistenceFailure {
  kind: AgentEventPersistenceFailureKind;
  event: AgentEvent;
  error: Error;
  /**
   * Number of same-kind failures represented by this notification. When an
   * asynchronous observer is still settling, later failures are coalesced
   * into its notification instead of accumulating an unbounded backlog.
   */
  occurrences: number;
}

export type AgentEventPersistenceFailureHandler = (
  failure: AgentEventPersistenceFailure,
) => void | Promise<void>;

export interface AgentEventPersistenceOptions extends PipeAgentEventsOptions {
  /**
   * Maximum number of accepted events waiting for, or currently undergoing,
   * persistence. Must be a positive integer. Default: 1024.
   */
  capacity?: number;
  /** Optional failure observer installed before the bus subscription starts. */
  onFailure?: AgentEventPersistenceFailureHandler;
}

/** Handle for an ordered, bounded AgentEvent persistence subscription. */
export interface AgentEventPersistenceBridge {
  /** Wait for every event accepted before this call to settle. */
  flush(): Promise<void>;
  /** Stop accepting events and drain accepted work. Idempotent. */
  close(): Promise<void>;
  /** Observe append failures and events rejected because the queue is full. */
  onFailure(handler: AgentEventPersistenceFailureHandler): () => void;
}

function errorFrom(value: unknown): Error {
  if (value instanceof Error) return value;
  try {
    return new Error(String(value));
  } catch {
    return new Error('Unknown persistence failure');
  }
}

function eventKey(
  options: PipeAgentEventsOptions,
): (event: AgentEvent) => string {
  return typeof options.key === 'function'
    ? options.key
    : options.key !== undefined
      ? () => options.key as string
      : (event: AgentEvent): string => `agent:${event.source}:${event.type}`;
}

/**
 * Persist adapter events through a finite, serial queue.
 *
 * Events accepted from the synchronous bus are appended in input order.
 * Once `capacity` accepted events are outstanding, later events are rejected
 * and reported as `overflow` failures rather than creating an unbounded
 * promise backlog. Append failures are reported and do not stall later work.
 * `flush` and `close` resolve after accepted appends and their failure
 * notifications settle, including failed appends. While an asynchronous
 * failure observer is pending, same-kind failures are coalesced into its
 * `occurrences` count so observer delivery is finitely bounded.
 */
export function createAgentEventPersistenceBridge(
  bus: AgentEventBus,
  store: JobStore,
  jobId: string,
  options: AgentEventPersistenceOptions = {},
): AgentEventPersistenceBridge {
  const capacity = options.capacity ?? 1024;
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError('capacity must be a positive safe integer');
  }

  const dropTypes = new Set(options.dropTypes ?? []);
  const keyFn = eventKey(options);
  const failureHandlers = new Set<AgentEventPersistenceFailureHandler>();
  if (options.onFailure) failureHandlers.add(options.onFailure);

  let outstanding = 0;
  let closed = false;
  let tail: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  interface FailureBatch {
    failure: AgentEventPersistenceFailure;
    settled: Promise<void>;
  }
  const activeFailureBatches = new Map<
    AgentEventPersistenceFailureKind,
    FailureBatch
  >();

  const report = (
    kind: AgentEventPersistenceFailureKind,
    event: AgentEvent,
    error: unknown,
  ): void => {
    const active = activeFailureBatches.get(kind);
    if (active) {
      active.failure.occurrences += 1;
      return;
    }

    const failure: AgentEventPersistenceFailure = {
      kind,
      event,
      error: errorFrom(error),
      occurrences: 1,
    };
    let settle!: () => void;
    const batch: FailureBatch = {
      failure,
      settled: new Promise<void>((resolve) => {
        settle = resolve;
      }),
    };
    activeFailureBatches.set(kind, batch);

    const observations: Promise<void>[] = [];
    for (const handler of failureHandlers) {
      try {
        observations.push(
          Promise.resolve(handler(failure)).then(
            () => {},
            () => {},
          ),
        );
      } catch {
        // Failure observers are terminal sinks and must not disrupt draining.
      }
    }
    void Promise.all(observations).then(() => {
      if (activeFailureBatches.get(kind) === batch) {
        activeFailureBatches.delete(kind);
      }
      settle();
    });
  };

  const failureBarrier = (): Promise<void> =>
    Promise.all(
      [...activeFailureBatches.values()].map((batch) => batch.settled),
    ).then(() => {});

  const drainAccepted = (acceptedTail: Promise<void>): Promise<void> =>
    acceptedTail.then(failureBarrier);

  const unsubscribe = bus.on((event) => {
    if (closed || dropTypes.has(event.type)) return;
    if (outstanding >= capacity) {
      report(
        'overflow',
        event,
        new Error(`AgentEvent persistence capacity ${capacity} exceeded`),
      );
      return;
    }

    outstanding += 1;
    tail = tail
      .then(async () => {
        const pipelineEvent: PipelineEvent = {
          type: 'data',
          key: keyFn(event),
          value: event,
        };
        await store.appendEvent(jobId, pipelineEvent);
      })
      .catch((error: unknown) => {
        report('append', event, error);
      })
      .finally(() => {
        outstanding -= 1;
      });
  });

  const bridge: AgentEventPersistenceBridge = {
    flush() {
      return drainAccepted(tail);
    },
    close() {
      if (!closePromise) {
        closed = true;
        unsubscribe();
        closePromise = drainAccepted(tail);
      }
      return closePromise;
    },
    onFailure(handler) {
      failureHandlers.add(handler);
      return () => {
        failureHandlers.delete(handler);
      };
    },
  };

  return bridge;
}

/** Alias emphasizing the bridge's persistence action. */
export const persistAgentEventsToJobStore = createAgentEventPersistenceBridge;

/**
 * Subscribe to a bus and append every agent event to the JobStore
 * under the given job id. Returns an unsubscribe function — call it
 * when the job ends so the bus doesn't retain the store reference.
 *
 * Adapter events are wrapped in a `PipelineEvent` of type `'data'`
 * (the JobStore's escape hatch for arbitrary payloads); the canonical
 * `AgentEvent` is the `value`.
 *
 */
export function pipeAgentEventsToJobStore(
  bus: AgentEventBus,
  store: JobStore,
  jobId: string,
  options: PipeAgentEventsOptions = {},
): () => void {
  const dropTypes = new Set(options.dropTypes ?? []);
  const keyFn = eventKey(options);

  return bus.on((event) => {
    if (dropTypes.has(event.type)) return;
    const pipelineEvent: PipelineEvent = {
      type: 'data',
      key: keyFn(event),
      value: event,
    };
    // Fire-and-forget: the bus signature is sync (`(event) => void`) but
    // appendEvent is async in v3. We swallow rejections so a store failure
    // doesn't poison the bus or surface as an unhandled rejection. Callers
    // needing bounded delivery, draining, or failure visibility should use
    // createAgentEventPersistenceBridge instead.
    try {
      const result = store.appendEvent(jobId, pipelineEvent);
      if (result && typeof (result as Promise<number>).then === 'function') {
        (result as Promise<number>).catch(() => {
          /* swallow — see comment above */
        });
      }
    } catch {
      // Sync throws (shouldn't happen with async API but defensive).
    }
  });
}
