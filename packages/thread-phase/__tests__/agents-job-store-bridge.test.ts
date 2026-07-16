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

  it('coalesces an overflow storm behind a blocked observer and includes it in flush', async () => {
    const store = newStore();
    const jobId = await store.createJob('observer-backpressure', null);
    const bus = createEventBus();
    const appendStarted = deferred();
    const appendFinished = deferred();
    const releaseAppend = deferred();
    const releaseObserver = deferred();
    const failures: AgentEventPersistenceFailure[] = [];
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
        failures.push(failure);
        await releaseObserver.promise;
      },
    });
    bus.emit({ type: 'text', source: 'mock', delta: 'accepted' });
    for (let index = 0; index < 10_000; index += 1) {
      bus.emit({ type: 'text', source: 'mock', delta: `overflow-${index}` });
    }

    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'overflow', occurrences: 10_000 });

    let flushed = false;
    const flushPromise = bridge.flush().then(() => {
      flushed = true;
    });
    await appendStarted.promise;
    releaseAppend.resolve();
    await appendFinished.promise;
    expect(flushed).toBe(false);

    releaseObserver.resolve();
    await flushPromise;
    expect(flushed).toBe(true);
    await bridge.close();
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
