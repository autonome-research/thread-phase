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
   * Number of same-kind failures represented by this immutable notification.
   * Failures arriving during its delivery are accumulated into at most one
   * pending notification rather than mutating this object after delivery.
   */
  readonly occurrences: number;
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
 * `flush` and `close` snapshot their barrier at invocation and resolve after
 * covered appends and failure notifications settle, including failed appends;
 * unrelated later events do not extend an existing barrier. While an asynchronous
 * failure observer is pending, same-kind failures are accumulated into one
 * immutable pending batch so observer delivery is finitely bounded and an
 * already delivered notification never changes.
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
  const pendingAcceptedSettlements = new Set<Promise<void>>();

  interface FailureAccumulator {
    readonly event: AgentEvent;
    readonly error: Error;
    readonly occurrences: number;
  }
  interface FailureBatch {
    readonly settled: Promise<void>;
    readonly settle: () => void;
  }
  interface PendingFailureBatch extends FailureBatch {
    accumulator: FailureAccumulator;
  }
  interface FailureState {
    readonly active: Set<FailureBatch>;
    pending?: PendingFailureBatch;
  }
  const failureStates = new Map<AgentEventPersistenceFailureKind, FailureState>();

  const newBatch = (): FailureBatch => {
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    return { settled, settle };
  };

  const deliver = (
    kind: AgentEventPersistenceFailureKind,
    state: FailureState,
    accumulator: FailureAccumulator,
    batch: FailureBatch,
  ): void => {
    state.active.add(batch);
    const failure = Object.freeze({
      kind,
      event: accumulator.event,
      error: accumulator.error,
      occurrences: accumulator.occurrences,
    }) satisfies AgentEventPersistenceFailure;

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
      state.active.delete(batch);
      batch.settle();

      if (state.active.size === 0) deliverPending(kind, state);
    });
  };

  const deliverPending = (
    kind: AgentEventPersistenceFailureKind,
    state: FailureState,
    force = false,
  ): void => {
    if (!force && state.active.size > 0) return;
    const pending = state.pending;
    if (!pending) return;
    state.pending = undefined;
    deliver(kind, state, pending.accumulator, pending);
  };

  const report = (
    kind: AgentEventPersistenceFailureKind,
    event: AgentEvent,
    error: unknown,
  ): Promise<void> => {
    let state = failureStates.get(kind);
    if (!state) {
      state = { active: new Set() };
      failureStates.set(kind, state);
    }

    if (state.pending) {
      const pending = state.pending;
      state.pending = {
        ...pending,
        accumulator: {
          ...pending.accumulator,
          occurrences: pending.accumulator.occurrences + 1,
        },
      };
      return pending.settled;
    }

    const batch = newBatch();
    state.pending = {
      ...batch,
      accumulator: { event, error: errorFrom(error), occurrences: 1 },
    };
    if (state.active.size === 0) {
      // Defer initial delivery so a synchronous failure burst is aggregated
      // before its immutable public notification is materialized.
      queueMicrotask(() => deliverPending(kind, state));
    }
    return batch.settled;
  };

  const drainAtInvocation = (): Promise<void> => {
    const accepted = [...pendingAcceptedSettlements];
    for (const [kind, state] of failureStates) {
      // Seal each pre-barrier aggregate before taking the snapshot. A later
      // failure must enter a new pending batch rather than changing which
      // observer work this invocation waits for.
      deliverPending(kind, state, true);
    }
    const observed = [...failureStates.values()].flatMap((state) =>
      [...state.active].map((batch) => batch.settled),
    );
    return Promise.all([...accepted, ...observed]).then(() => {});
  };

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
    const appendAttempt = tail.then(async () => {
      const pipelineEvent: PipelineEvent = {
        type: 'data',
        key: keyFn(event),
        value: event,
      };
      await store.appendEvent(jobId, pipelineEvent);
    });
    tail = appendAttempt
      .catch(() => {})
      .finally(() => {
        outstanding -= 1;
      });

    const settlement = appendAttempt.catch((error: unknown) =>
      report('append', event, error),
    );
    pendingAcceptedSettlements.add(settlement);
    void appendAttempt.then(
      () => pendingAcceptedSettlements.delete(settlement),
      () => pendingAcceptedSettlements.delete(settlement),
    );
  });

  const bridge: AgentEventPersistenceBridge = {
    flush() {
      return drainAtInvocation();
    },
    close() {
      if (!closePromise) {
        closed = true;
        unsubscribe();
        closePromise = drainAtInvocation();
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
