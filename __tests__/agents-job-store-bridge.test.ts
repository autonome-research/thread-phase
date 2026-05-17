import { describe, it, expect } from 'vitest';
import {
  createEventBus,
  pipeAgentEventsToJobStore,
  type AgentEvent,
} from '../src/agents/index.js';
import { SqliteJobStore } from '../src/session/index.js';

function newStore(): SqliteJobStore {
  return new SqliteJobStore(':memory:');
}

describe('pipeAgentEventsToJobStore', () => {
  it('appends every bus event to the job store under default keys', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    const unsubscribe = pipeAgentEventsToJobStore(bus, store, jobId);

    const events: AgentEvent[] = [
      { type: 'agent_start', source: 'mock' },
      { type: 'text', source: 'mock', delta: 'hi' },
      { type: 'agent_end', source: 'mock', reason: 'stop' },
    ];
    for (const event of events) bus.emit(event);

    const records = store.getEvents(jobId);
    expect(records).toHaveLength(3);
    expect(records[0]?.eventType).toBe('data');
    const datas = records.map((r) => r.data);
    expect(datas[0]).toEqual({ type: 'data', key: 'agent:mock:agent_start', value: events[0] });
    expect(datas[1]).toEqual({ type: 'data', key: 'agent:mock:text', value: events[1] });
    expect(datas[2]).toEqual({ type: 'data', key: 'agent:mock:agent_end', value: events[2] });

    unsubscribe();
    store.close();
  });

  it('honors dropTypes to skip high-volume event types', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { dropTypes: ['text'] });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'a' });
    bus.emit({ type: 'text', source: 'mock', delta: 'b' });
    bus.emit({ type: 'agent_end', source: 'mock', reason: 'stop' });

    const records = store.getEvents(jobId);
    expect(records).toHaveLength(2);
    const keys = records.map((r) => (r.data.type === 'data' ? r.data.key : ''));
    expect(keys).toEqual(['agent:mock:agent_start', 'agent:mock:agent_end']);

    store.close();
  });

  it('respects a string key override', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, { key: 'adapter_event' });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'hi' });

    const records = store.getEvents(jobId);
    expect(records.every((r) => r.data.type === 'data' && r.data.key === 'adapter_event')).toBe(true);

    store.close();
  });

  it('respects a function key override', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId, {
      key: (event) => `${event.source}_event_${event.type}`,
    });

    bus.emit({ type: 'agent_start', source: 'mock' });
    bus.emit({ type: 'text', source: 'mock', delta: 'hi' });

    const records = store.getEvents(jobId);
    const keys = records.map((r) => (r.data.type === 'data' ? r.data.key : ''));
    expect(keys).toEqual(['mock_event_agent_start', 'mock_event_text']);

    store.close();
  });

  it('unsubscribe stops further appends', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    const unsubscribe = pipeAgentEventsToJobStore(bus, store, jobId);

    bus.emit({ type: 'agent_start', source: 'mock' });
    unsubscribe();
    bus.emit({ type: 'text', source: 'mock', delta: 'should not persist' });

    const records = store.getEvents(jobId);
    expect(records).toHaveLength(1);

    store.close();
  });

  it('store append failures do not throw out of the bus emit', () => {
    const store = newStore();
    const jobId = store.createJob('test', null);
    const bus = createEventBus();
    pipeAgentEventsToJobStore(bus, store, jobId);

    // Close the store so subsequent appendEvent calls throw.
    store.close();

    // Emit should not throw — the bridge swallows store failures.
    expect(() => bus.emit({ type: 'agent_start', source: 'mock' })).not.toThrow();
  });
});
