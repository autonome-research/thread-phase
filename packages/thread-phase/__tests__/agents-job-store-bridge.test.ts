import { describe, it, expect } from 'vitest';
import {
  createEventBus,
  persistAgentEventsToJobStore,
  pipeAgentEventsToJobStore,
  type AgentEvent,
  type AgentEventBus,
  type AgentEventPersistenceFailure,
} from '../src/agents/index.js';
import { SqliteJobStore } from '../src/session/index.js';

function newStore(): SqliteJobStore {
  return new SqliteJobStore(':memory:');
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// The bridge subscribes synchronously but appendEvent is now async — events
// are persisted on the next microtask. Tests flush by awaiting a microtask
// before reading back.
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('persistAgentEventsToJobStore', () => {
  it('serializes accepted appends in bus input order and flushes deterministically', async () => {
    const store = newStore();
    const jobId = await store.createJob('ordered', null);
    const bus = createEventBus();
    const originalAppend = store.appendEvent.bind(store);
    const gates = [deferred(), deferred(), deferred()];
    const starts = [deferred(), deferred(), deferred()];
    const startedKeys: string[] = [];

    store.appendEvent = async (id, event) => {
      const index = startedKeys.length;
      startedKeys.push(event.type === 'data' ? event.key : event.type);
      starts[index]!.resolve();
      await gates[index]!.promise;
      return originalAppend(id, event);
    };

    const bridge = persistAgentEventsToJobStore(bus, store, jobId, { capacity: 3 });
    bus.emit({ type: 'text', source: 'mock', delta: 'first' });
    bus.emit({ type: 'thinking', source: 'mock', delta: 'second' });
    bus.emit({ type: 'agent_end', source: 'mock', reason: 'stop' });
    const flushed = bridge.flush();

    await starts[0]!.promise;
    expect(startedKeys).toEqual(['agent:mock:text']);
    gates[0]!.resolve();
    await starts[1]!.promise;
    expect(startedKeys).toEqual(['agent:mock:text', 'agent:mock:thinking']);
    gates[1]!.resolve();
    await starts[2]!.promise;
    gates[2]!.resolve();
    await flushed;

    const records = await store.getEvents(jobId);
    expect(records.map((record) => record.data.type === 'data' && record.data.key)).toEqual([
      'agent:mock:text',
      'agent:mock:thinking',
      'agent:mock:agent_end',
    ]);
    await bridge.close();
    store.close();
  });

  it('rejects overflow explicitly while retaining and draining accepted work', async () => {
    const store = newStore();
    const jobId = await store.createJob('bounded', null);
    const bus = createEventBus();
    const originalAppend = store.appendEvent.bind(store);
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const failures: AgentEventPersistenceFailure[] = [];
    let appendCount = 0;

    store.appendEvent = async (id, event) => {
      appendCount += 1;
      if (appendCount === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return originalAppend(id, event);
    };

    const bridge = persistAgentEventsToJobStore(bus, store, jobId, {
      capacity: 2,
      onFailure: (failure) => failures.push(failure),
    });
    bus.emit({ type: 'text', source: 'mock', delta: 'accepted-1' });
    bus.emit({ type: 'text', source: 'mock', delta: 'accepted-2' });
    bus.emit({ type: 'text', source: 'mock', delta: 'overflow' });

    await firstStarted.promise;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: 'overflow',
      event: { type: 'text', delta: 'overflow' },
    });
    releaseFirst.resolve();
    await bridge.flush();
    expect(await store.getEvents(jobId)).toHaveLength(2);
    await bridge.close();
    store.close();
  });

  it('observes append failures, continues draining, and closes idempotently', async () => {
    const store = newStore();
    const jobId = await store.createJob('failures', null);
    const bus = createEventBus();
    const originalAppend = store.appendEvent.bind(store);
    const failures: AgentEventPersistenceFailure[] = [];
    const attempted: string[] = [];

    store.appendEvent = async (id, event) => {
      const delta = event.type === 'data'
        && typeof event.value === 'object'
        && event.value !== null
        && 'delta' in event.value
        ? String(event.value.delta)
        : '';
      attempted.push(delta);
      if (delta === 'bad') throw new Error('disk unavailable');
      return originalAppend(id, event);
    };

    const bridge = persistAgentEventsToJobStore(bus, store, jobId, { capacity: 3 });
    const unsubscribeFailure = bridge.onFailure((failure) => failures.push(failure));
    bus.emit({ type: 'text', source: 'mock', delta: 'before' });
    bus.emit({ type: 'text', source: 'mock', delta: 'bad' });
    bus.emit({ type: 'text', source: 'mock', delta: 'after' });

    const firstClose = bridge.close();
    expect(bridge.close()).toBe(firstClose);
    bus.emit({ type: 'text', source: 'mock', delta: 'after-close' });
    await firstClose;

    expect(attempted).toEqual(['before', 'bad', 'after']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.kind).toBe('append');
    expect(failures[0]?.error.message).toBe('disk unavailable');
    expect(await store.getEvents(jobId)).toHaveLength(2);
    unsubscribeFailure();
    store.close();
  });

  it('snapshots failure observers so callback mutations affect only later notifications', async () => {
    const store = newStore();
    const jobId = await store.createJob('observer-snapshot', null);
    const bus = createEventBus();
    store.appendEvent = async () => { throw new Error('append failed'); };
    const bridge = persistAgentEventsToJobStore(bus, store, jobId, { capacity: 1 });
    const seen: string[] = [];
    const third = () => { seen.push('third'); };
    let removeSecond = () => {};

    bridge.onFailure(() => {
      seen.push('first');
      removeSecond();
      bridge.onFailure(third);
    });
    removeSecond = bridge.onFailure(() => { seen.push('second'); });

    bus.emit({ type: 'text', source: 'mock', delta: 'one' });
    await bridge.flush();
    expect(seen).toEqual(['first', 'second']);

    seen.length = 0;
    bus.emit({ type: 'text', source: 'mock', delta: 'two' });
    await bridge.flush();
    expect(seen).toEqual(['first', 'third']);

    await bridge.close();
    store.close();
  });

  it('delivers an overflow storm as bounded immutable batches and flushes pending observation', async () => {
    const store = newStore();
    const jobId = await store.createJob('observer-backpressure', null);
    const bus = createEventBus();
    const appendStarted = deferred();
    const appendFinished = deferred();
    const releaseAppend = deferred();
    const observerStarted = [deferred(), deferred(), deferred()];
    const releaseObserver = [deferred(), deferred(), deferred()];
    const failures: AgentEventPersistenceFailure[] = [];
    const occurrencesAtDispatch: number[] = [];
    const originalAppend = store.appendEvent.bind(store);

    store.appendEvent = async (id, event) => {
      appendStarted.resolve();
      await releaseAppend.promise;
      const result = await originalAppend(id, event);
      appendFinished.resolve();
      return result;
    };

    const bridge = persistAgentEventsToJobStore(bus, store, jobId, {
      capacity: 1,
      onFailure: async (failure) => {
        const index = failures.length;
        failures.push(failure);
        occurrencesAtDispatch.push(failure.occurrences);
        observerStarted[index]!.resolve();
        await releaseObserver[index]!.promise;
      },
    });
    bus.emit({ type: 'text', source: 'mock', delta: 'accepted' });
    bus.emit({ type: 'text', source: 'mock', delta: 'overflow-0' });

    await observerStarted[0]!.promise;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      kind: 'overflow',
      event: { delta: 'overflow-0' },
      occurrences: 1,
    });
    expect(Object.isFrozen(failures[0])).toBe(true);

    for (let index = 1; index < 10_000; index += 1) {
      bus.emit({ type: 'text', source: 'mock', delta: `overflow-${index}` });
    }

    let flushed = false;
    const flushPromise = bridge.flush().then(() => {
      flushed = true;
    });
    bus.emit({ type: 'text', source: 'mock', delta: 'post-flush-overflow' });

    await appendStarted.promise;
    releaseAppend.resolve();
    await appendFinished.promise;
    expect(flushed).toBe(false);
    expect(failures).toHaveLength(1);

    releaseObserver[0]!.resolve();
    await observerStarted[1]!.promise;
    expect(failures).toHaveLength(2);
    expect(failures[0]?.occurrences).toBe(1);
    expect(failures[1]).toMatchObject({
      kind: 'overflow',
      event: { delta: 'overflow-1' },
      occurrences: 9_999,
    });
    expect(Object.isFrozen(failures[1])).toBe(true);
    expect(flushed).toBe(false);

    releaseObserver[1]!.resolve();
    await observerStarted[2]!.promise;
    await flushPromise;
    expect(flushed).toBe(true);
    expect(failures[2]).toMatchObject({
      kind: 'overflow',
      event: { delta: 'post-flush-overflow' },
      occurrences: 1,
    });
    expect(failures.map((failure) => failure.occurrences)).toEqual(occurrencesAtDispatch);
    expect(occurrencesAtDispatch.reduce((total, count) => total + count, 0)).toBe(10_001);

    releaseObserver[2]!.resolve();
    await bridge.close();
    store.close();
  });

  it('seals repeated flush barriers while keeping same-kind observer state bounded and serial', async () => {
    const store = newStore();
    const bus = createEventBus();
    const releaseAppend = deferred();
    const observerStarted = [deferred(), deferred(), deferred()];
    const releaseObserver = [deferred(), deferred(), deferred()];
    const occurrences: number[] = [];
    let activeObservers = 0;
    let maximumActiveObservers = 0;

    store.appendEvent = async () => {
      await releaseAppend.promise;
      return 1;
    };
    const bridge = persistAgentEventsToJobStore(bus, store, 'repeated-barriers', {
      capacity: 1,
      onFailure: async (failure) => {
        const index = occurrences.length;
        occurrences.push(failure.occurrences);
        activeObservers += 1;
        maximumActiveObservers = Math.max(maximumActiveObservers, activeObservers);
        observerStarted[index]!.resolve();
        await releaseObserver[index]!.promise;
        activeObservers -= 1;
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'accepted' });
    bus.emit({ type: 'text', source: 'mock', delta: 'first-overflow' });
    await observerStarted[0]!.promise;

    const barriers: Promise<void>[] = [];
    const resolved = Array.from({ length: 1_000 }, () => false);
    for (let index = 0; index < 1_000; index += 1) {
      bus.emit({ type: 'text', source: 'mock', delta: `pending-${index}` });
      barriers.push(
        bridge.flush().then(() => {
          resolved[index] = true;
        }),
      );
    }
    await Promise.resolve();
    expect(occurrences).toEqual([1]);
    expect(maximumActiveObservers).toBe(1);

    releaseAppend.resolve();
    releaseObserver[0]!.resolve();
    await observerStarted[1]!.promise;
    expect(occurrences).toEqual([1, 1]);
    expect(maximumActiveObservers).toBe(1);
    expect(resolved.every((value) => !value)).toBe(true);

    releaseObserver[1]!.resolve();
    await observerStarted[2]!.promise;
    await barriers[0];
    expect(resolved[0]).toBe(true);
    expect(resolved.slice(1).every((value) => !value)).toBe(true);
    expect(occurrences).toEqual([1, 1, 999]);
    expect(maximumActiveObservers).toBe(1);

    releaseObserver[2]!.resolve();
    await Promise.all(barriers);
    expect(resolved.every(Boolean)).toBe(true);
    expect(maximumActiveObservers).toBe(1);
    await bridge.close();
    store.close();
  });

  it('seals pre-invocation overflow without waiting for later failure observation', async () => {
    const store = newStore();
    const bus = createEventBus();
    const appendStarted = deferred();
    const releaseAppend = deferred();
    const observerStarted = [deferred(), deferred()];
    const releaseObserver = [deferred(), deferred()];
    const observed: AgentEventPersistenceFailure[] = [];

    store.appendEvent = async () => {
      appendStarted.resolve();
      await releaseAppend.promise;
      return 1;
    };
    const bridge = persistAgentEventsToJobStore(bus, store, 'overflow-barrier', {
      capacity: 1,
      onFailure: async (failure) => {
        const index = observed.length;
        observed.push(failure);
        observerStarted[index]!.resolve();
        await releaseObserver[index]!.promise;
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'accepted' });
    bus.emit({ type: 'text', source: 'mock', delta: 'pre-barrier-overflow' });
    const flushed = bridge.flush();

    // The invocation seals the covered notification. A later failure gets a
    // separate serial delivery and cannot extend this flush barrier.
    bus.emit({ type: 'text', source: 'mock', delta: 'post-barrier-overflow' });
    await appendStarted.promise;
    await observerStarted[0]!.promise;
    releaseAppend.resolve();
    expect(observed).toMatchObject([
      { kind: 'overflow', event: { delta: 'pre-barrier-overflow' }, occurrences: 1 },
    ]);
    releaseObserver[0]!.resolve();
    await observerStarted[1]!.promise;
    await flushed;
    expect(observed).toMatchObject([
      { kind: 'overflow', event: { delta: 'pre-barrier-overflow' }, occurrences: 1 },
      { kind: 'overflow', event: { delta: 'post-barrier-overflow' }, occurrences: 1 },
    ]);

    releaseObserver[1]!.resolve();
    await bridge.close();
    store.close();
  });

  it('does not extend an append-failure flush barrier with post-invocation work', async () => {
    const store = newStore();
    const bus = createEventBus();
    const attempts = [deferred(), deferred()];
    const observerStarted = [deferred(), deferred()];
    const releaseObserver = [deferred(), deferred()];
    const observed: AgentEventPersistenceFailure[] = [];
    let attempt = 0;

    store.appendEvent = async () => {
      const index = attempt++;
      attempts[index]!.resolve();
      throw new Error(`write ${index} failed`);
    };
    const bridge = persistAgentEventsToJobStore(bus, store, 'append-barrier', {
      capacity: 2,
      onFailure: async (failure) => {
        const index = observed.length;
        observed.push(failure);
        observerStarted[index]!.resolve();
        await releaseObserver[index]!.promise;
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'pre-barrier-append' });
    const flushed = bridge.flush();
    bus.emit({ type: 'text', source: 'mock', delta: 'post-barrier-append' });

    await attempts[0]!.promise;
    await observerStarted[0]!.promise;
    await attempts[1]!.promise;
    releaseObserver[0]!.resolve();
    await observerStarted[1]!.promise;
    await flushed;

    expect(observed.map((failure) => failure.error.message)).toEqual([
      'write 0 failed',
      'write 1 failed',
    ]);
    releaseObserver[1]!.resolve();
    await bridge.close();
    store.close();
  });

  it('keeps capacity-1 append-failure settlement state bounded while flush and close drain it', async () => {
    const store = newStore();
    const bus = createEventBus();
    const observerStarted = [deferred(), deferred()];
    const releaseObserver = [deferred(), deferred()];
    const observed: AgentEventPersistenceFailure[] = [];
    const failureCount = 3_200;
    let attempts = 0;

    store.appendEvent = async () => {
      attempts += 1;
      throw new Error('write failed');
    };
    const bridge = persistAgentEventsToJobStore(bus, store, 'recycled-failures', {
      capacity: 1,
      onFailure: async (failure) => {
        expect(failure.kind).toBe('append');
        const index = observed.length;
        observed.push(failure);
        observerStarted[index]!.resolve();
        await releaseObserver[index]!.promise;
      },
    });

    for (let index = 0; index < failureCount; index += 1) {
      bus.emit({ type: 'text', source: 'mock', delta: String(index) });
      // The failing store has no asynchronous work. The event-loop boundary
      // deterministically settles this one accepted append and recycles the
      // sole capacity slot before the next event is emitted.
      await flush();
    }
    await observerStarted[0]!.promise;
    expect(attempts).toBe(failureCount);
    // One immutable active notification and one coalesced pending generation
    // represent the whole storm; no callback-time object is retained per event.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.occurrences).toBe(1);

    let flushed = false;
    const flushPromise = bridge.flush().then(() => {
      flushed = true;
    });
    const closePromise = bridge.close();
    expect(bridge.close()).toBe(closePromise);
    bus.emit({ type: 'text', source: 'mock', delta: 'after-close' });
    await flush();
    expect(attempts).toBe(failureCount);
    expect(flushed).toBe(false);

    releaseObserver[0]!.resolve();
    await observerStarted[1]!.promise;
    expect(observed).toHaveLength(2);
    expect(observed[1]?.occurrences).toBe(failureCount - 1);
    expect(observed.reduce((sum, failure) => sum + failure.occurrences, 0)).toBe(
      failureCount,
    );
    expect(flushed).toBe(false);

    releaseObserver[1]!.resolve();
    await Promise.all([flushPromise, closePromise]);
    expect(flushed).toBe(true);
    store.close();
  });

  it('waits for append-failure observation when closing', async () => {
    const store = newStore();
    const bus = createEventBus();
    const appendAttempted = deferred();
    const observerStarted = deferred();
    const releaseObserver = deferred();
    let observed: AgentEventPersistenceFailure | undefined;

    store.appendEvent = async () => {
      appendAttempted.resolve();
      throw new Error('write failed');
    };
    const bridge = persistAgentEventsToJobStore(bus, store, 'failed-job', {
      onFailure: async (failure) => {
        observed = failure;
        observerStarted.resolve();
        await releaseObserver.promise;
      },
    });
    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });

    let closed = false;
    const closePromise = bridge.close().then(() => {
      closed = true;
    });
    await appendAttempted.promise;
    await observerStarted.promise;
    expect(observed).toMatchObject({ kind: 'append', occurrences: 1 });
    expect(closed).toBe(false);

    releaseObserver.resolve();
    await closePromise;
    expect(closed).toBe(true);
    store.close();
  });

  it('allows a failure observer to await reentrant close after an async boundary', async () => {
    const store = newStore();
    const bus = createEventBus();
    const observerSettled = deferred();
    store.appendEvent = async () => { throw new Error('write failed'); };
    let bridge!: ReturnType<typeof persistAgentEventsToJobStore>;
    bridge = persistAgentEventsToJobStore(bus, store, 'reentrant-close', {
      onFailure: async () => {
        await Promise.resolve();
        await bridge.close();
        observerSettled.resolve();
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });
    await Promise.race([
      observerSettled.promise,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('reentrant close deadlocked')),
        1_000,
      )),
    ]);
    await bridge.close();
    store.close();
  });

  it('reentrant close excludes only its caller and waits for sibling observers', async () => {
    const store = newStore();
    const bus = createEventBus();
    const firstEntered = deferred();
    const firstPassedClose = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    store.appendEvent = async () => { throw new Error('write failed'); };
    const bridge = persistAgentEventsToJobStore(bus, store, 'reentrant-close-siblings');
    bridge.onFailure(async () => {
      firstEntered.resolve();
      await bridge.close();
      firstPassedClose.resolve();
    });
    bridge.onFailure(async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    let firstPassed = false;
    void firstPassedClose.promise.then(() => { firstPassed = true; });
    await Promise.resolve();
    expect(firstPassed).toBe(false);

    releaseSecond.resolve();
    await firstPassedClose.promise;
    await bridge.close();
    store.close();
  });

  it('reentrant flush excludes only its caller and waits for sibling observers', async () => {
    const store = newStore();
    const bus = createEventBus();
    const firstEntered = deferred();
    const firstPassedFlush = deferred();
    const secondEntered = deferred();
    const releaseSecond = deferred();
    store.appendEvent = async () => { throw new Error('write failed'); };
    const bridge = persistAgentEventsToJobStore(bus, store, 'reentrant-flush-siblings');
    bridge.onFailure(async () => {
      firstEntered.resolve();
      await bridge.flush();
      firstPassedFlush.resolve();
    });
    bridge.onFailure(async () => {
      secondEntered.resolve();
      await releaseSecond.promise;
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });
    await Promise.all([firstEntered.promise, secondEntered.promise]);
    let firstPassed = false;
    void firstPassedFlush.promise.then(() => { firstPassed = true; });
    await Promise.resolve();
    expect(firstPassed).toBe(false);

    releaseSecond.resolve();
    await firstPassedFlush.promise;
    await bridge.close();
    store.close();
  });

  it('keeps the external close barrier pending after an observer initiates close', async () => {
    const store = newStore();
    const bus = createEventBus();
    const observerPassedClose = deferred();
    const releaseObserver = deferred();
    store.appendEvent = async () => { throw new Error('write failed'); };
    let bridge!: ReturnType<typeof persistAgentEventsToJobStore>;
    bridge = persistAgentEventsToJobStore(bus, store, 'observer-initiated-close', {
      onFailure: async () => {
        await Promise.resolve();
        await bridge.close();
        observerPassedClose.resolve();
        await releaseObserver.promise;
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });
    await observerPassedClose.promise;
    let externalCloseSettled = false;
    const externalClose = bridge.close().then(() => {
      externalCloseSettled = true;
    });
    await Promise.resolve();
    expect(externalCloseSettled).toBe(false);

    releaseObserver.resolve();
    await externalClose;
    expect(externalCloseSettled).toBe(true);
    store.close();
  });

  it('allows a failure observer to await reentrant flush after an async boundary', async () => {
    const store = newStore();
    const bus = createEventBus();
    const observerSettled = deferred();
    store.appendEvent = async () => { throw new Error('write failed'); };
    let bridge!: ReturnType<typeof persistAgentEventsToJobStore>;
    bridge = persistAgentEventsToJobStore(bus, store, 'reentrant-flush', {
      onFailure: async () => {
        await Promise.resolve();
        await bridge.flush();
        observerSettled.resolve();
      },
    });

    bus.emit({ type: 'text', source: 'mock', delta: 'failure' });
    await Promise.race([
      observerSettled.promise,
      new Promise<never>((_, reject) => setTimeout(
        () => reject(new Error('reentrant flush deadlocked')),
        1_000,
      )),
    ]);
    await bridge.close();
    store.close();
  });

  it('validates finite queue capacity before subscribing', () => {
    const bus = createEventBus();
    const store = newStore();
    expect(() => persistAgentEventsToJobStore(bus, store, 'job', { capacity: 0 })).toThrow(
      /positive safe integer/,
    );
    expect(() => persistAgentEventsToJobStore(bus, store, 'job', { capacity: Infinity })).toThrow(
      /positive safe integer/,
    );
    store.close();
  });
});

describe('pipeAgentEventsToJobStore', () => {
  it('keeps the legacy signature and isolates sync throws and async rejections', async () => {
    const handlers = new Set<(event: AgentEvent) => void>();
    const bus: AgentEventBus = {
      emit(event) {
        for (const handler of handlers) handler(event);
      },
      on(handler) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
    };
    const store = newStore();
    let appendAttempts = 0;
    store.appendEvent = ((() => {
      appendAttempts += 1;
      if (appendAttempts === 1) throw new Error('synchronous store failure');
      return Promise.reject(new Error('asynchronous store failure'));
    }) as typeof store.appendEvent);
    const siblingEvents: AgentEvent[] = [];

    const unsubscribe: () => void = pipeAgentEventsToJobStore(bus, store, 'legacy-job');
    bus.on((event) => siblingEvents.push(event));

    expect(bus.emit({ type: 'text', source: 'legacy', delta: 'one' })).toBeUndefined();
    expect(bus.emit({ type: 'text', source: 'legacy', delta: 'two' })).toBeUndefined();
    await flush();

    expect(appendAttempts).toBe(2);
    expect(siblingEvents.map((event) => event.type)).toEqual(['text', 'text']);
    unsubscribe();
    bus.emit({ type: 'agent_end', source: 'legacy', reason: 'stop' });
    expect(appendAttempts).toBe(2);
    store.close();
  });

  it('appends every bus event to the job store under default keys', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    const unsubscribe = pipeAgentEventsToJobStore(bus, store, jobId);

    const events: AgentEvent[] = [
      { type: 'agent_start', source: 'mock' },
      { type: 'text', source: 'mock', delta: 'hi' },
      { type: 'agent_end', source: 'mock', reason: 'stop' },
    ];
    for (const event of events) bus.emit(event);

    await flush();
    const records = await store.getEvents(jobId);
    expect(records).toHaveLength(3);
    expect(records[0]?.eventType).toBe('data');
    const datas = records.map((r) => r.data);
    expect(datas[0]).toEqual({ type: 'data', key: 'agent:mock:agent_start', value: events[0] });
    expect(datas[1]).toEqual({ type: 'data', key: 'agent:mock:text', value: events[1] });
    expect(datas[2]).toEqual({ type: 'data', key: 'agent:mock:agent_end', value: events[2] });

    unsubscribe();
    store.close();
  });

  it('honors dropTypes to skip high-volume event types', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { dropTypes: ['text'] });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'a' });
    bus.emit({ type: 'text', source: 'mock', delta: 'b' });
    bus.emit({ type: 'agent_end', source: 'mock', reason: 'stop' });

    await flush();
    const records = await store.getEvents(jobId);
    expect(records).toHaveLength(2);
    const keys = records.map((r) => (r.data.type === 'data' ? r.data.key : ''));
    expect(keys).toEqual(['agent:mock:agent_start', 'agent:mock:agent_end']);

    store.close();
  });

  it('respects a string key override', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { key: 'adapter_event' });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'hi' });

    await flush();
    const records = await store.getEvents(jobId);
    expect(records.every((r) => r.data.type === 'data' && r.data.key === 'adapter_event')).toBe(true);

    store.close();
  });

  it('respects a function key override', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, {
      key: (event) => `${event.source}_event_${event.type}`,
    });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'hi' });

    await flush();
    const records = await store.getEvents(jobId);
    const keys = records.map((r) => (r.data.type === 'data' ? r.data.key : ''));
    expect(keys).toEqual(['mock_event_agent_start', 'mock_event_text']);

    store.close();
  });

  it('unsubscribe stops further appends', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    const unsubscribe = pipeAgentEventsToJobStore(bus, store, jobId);

    bus.emit({ type: 'agent_start', source: 'mock' });
    unsubscribe();
    bus.emit({ type: 'text', source: 'mock', delta: 'should not persist' });

    await flush();
    const records = await store.getEvents(jobId);
    expect(records).toHaveLength(1);

    store.close();
  });

  it('store append failures do not throw out of the bus emit', async () => {
    const store = newStore();
    const jobId = await store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId);

    // Close the store so subsequent appendEvent calls throw.
    store.close();

    // Emit should not throw — the bridge swallows store failures (sync or async).
    expect(() => bus.emit({ type: 'agent_start', source: 'mock' })).not.toThrow();
    // Drain any pending microtask so an unhandled rejection would surface.
    await flush();
  });
});
