import { describe, expect, expectTypeOf, it } from 'vitest';
import { createEventBus } from '../src/agents/event-bus.js';
import type {
  AgentEvent,
  AgentEventBus,
  AgentEventHandler,
  AgentEventHandlerFailure,
} from '../src/agents/protocol.js';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function recordUnhandled(action: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', listener);
  try {
    await action();
    await nextTurn();
    return unhandled;
  } finally {
    process.off('unhandledRejection', listener);
  }
}

const event: AgentEvent = {
  type: 'native',
  source: 'event-bus-contract',
  kind: 'test',
  payload: { sequence: 1 },
};

class V5StructuralEventBus implements AgentEventBus {
  private readonly handlers = new Set<AgentEventHandler>();

  emit(emitted: AgentEvent): void {
    for (const handler of this.handlers) handler(emitted);
  }

  on(handler: AgentEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

describe('AgentEventBus handler-failure contract', () => {
  it('runs an unchanged emit/on-only v5 structural bus fixture', () => {
    const legacyBus: AgentEventBus = new V5StructuralEventBus();
    const seen: AgentEvent[] = [];
    const unsubscribe = legacyBus.on((emitted) => seen.push(emitted));

    legacyBus.emit(event);
    unsubscribe();
    legacyBus.emit(event);

    expect(seen).toEqual([event]);
  });

  it('keeps emit synchronous and non-blocking for asynchronous handlers', async () => {
    const bus = createEventBus();
    const release = deferred();
    const entered = deferred();
    const order: string[] = [];

    bus.on(async () => {
      order.push('async-entered');
      entered.resolve();
      await release.promise;
      order.push('async-finished');
    });
    bus.on(() => {
      order.push('healthy');
    });

    expectTypeOf(bus.emit).returns.toEqualTypeOf<void>();
    const returned = bus.emit(event);

    expect(returned).toBeUndefined();
    expect(order).toEqual(['async-entered', 'healthy']);
    await entered.promise;
    release.resolve();
    await nextTurn();
    expect(order).toEqual(['async-entered', 'healthy', 'async-finished']);
  });

  it('isolates a synchronous throw and continues fanout to every healthy subscriber', () => {
    const bus = createEventBus();
    const seen: string[] = [];

    bus.on(() => {
      seen.push('before-throw');
    });
    bus.on(() => {
      throw new Error('subscriber broke synchronously');
    });
    bus.on(() => {
      seen.push('after-throw');
    });

    expect(() => bus.emit(event)).not.toThrow();
    expect(seen).toEqual(['before-throw', 'after-throw']);
  });

  it('contains a delayed asynchronous rejection without interrupting healthy fanout', async () => {
    const bus = createEventBus();
    const release = deferred();
    const entered = deferred();
    const seen: string[] = [];

    bus.on(async () => {
      entered.resolve();
      await release.promise;
      throw new Error('subscriber rejected later');
    });
    bus.on(() => {
      seen.push('healthy');
    });

    const unhandled = await recordUnhandled(async () => {
      bus.emit(event);
      expect(seen).toEqual(['healthy']);
      await entered.promise;
      release.resolve();
    });

    expect(unhandled).toEqual([]);
    expect(seen).toEqual(['healthy']);
  });

  it('removes only the requested subscription and removal is idempotent', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const removeFirst = bus.on(() => seen.push('first'));
    bus.on(() => seen.push('second'));

    bus.emit(event);
    removeFirst();
    removeFirst();
    bus.emit(event);

    expect(seen).toEqual(['first', 'second', 'second']);
  });

  it('snapshots subscriptions for deterministic add/remove during emit', () => {
    const bus = createEventBus();
    const seen: string[] = [];
    const third = () => { seen.push('third'); };
    let removeSecond!: () => void;
    bus.on(() => {
      seen.push('first');
      removeSecond();
      bus.on(third);
    });
    removeSecond = bus.on(() => { seen.push('second'); });

    bus.emit(event);
    expect(seen).toEqual(['first', 'second']);
    seen.length = 0;
    bus.emit(event);
    expect(seen).toEqual(['first', 'third']);
  });

  it('removes only the requested error observer and removal is idempotent', () => {
    const bus = createEventBus();
    const observed: string[] = [];
    const removeFirst = bus.onHandlerError(() => observed.push('first'));
    bus.onHandlerError(() => observed.push('second'));
    bus.on(() => {
      throw new Error('subscriber failure');
    });

    bus.emit(event);
    removeFirst();
    removeFirst();
    bus.emit(event);

    expect(observed).toEqual(['first', 'second', 'second']);
  });

  it('reports the failed handler, original event, and a normalized Error', () => {
    const bus = createEventBus();
    const failures: AgentEventHandlerFailure[] = [];
    const failedHandler: AgentEventHandler = () => {
      throw 'non-error failure';
    };

    bus.onHandlerError((failure) => failures.push(failure));
    bus.on(failedHandler);
    bus.emit(event);

    expect(failures).toHaveLength(1);
    expect(failures[0]?.handler).toBe(failedHandler);
    expect(failures[0]?.event).toBe(event);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.error.message).toBe('non-error failure');
  });

  it('reports delayed asynchronous rejection through the same observable path', async () => {
    const bus = createEventBus();
    const release = deferred();
    const entered = deferred();
    const observed = deferred<AgentEventHandlerFailure>();
    const failure = new Error('delayed observable failure');
    const failedHandler: AgentEventHandler = async () => {
      entered.resolve();
      await release.promise;
      throw failure;
    };

    bus.onHandlerError((reported) => observed.resolve(reported));
    bus.on(failedHandler);
    bus.emit(event);
    await entered.promise;
    release.resolve();

    const reported = await observed.promise;
    expect(reported).toEqual({ handler: failedHandler, event, error: failure });
  });

  it('contains error-observer failures without recursive error reporting', async () => {
    const bus = createEventBus();
    const releaseObserver = deferred();
    const observerEntered = deferred();
    const observed: AgentEventHandlerFailure[] = [];
    const failedHandler: AgentEventHandler = () => {
      throw new Error('ordinary subscriber failure');
    };

    bus.onHandlerError(async () => {
      observerEntered.resolve();
      await releaseObserver.promise;
      throw new Error('error observer rejected');
    });
    bus.onHandlerError((failure) => {
      observed.push(failure);
      throw new Error('error observer threw');
    });
    bus.on(failedHandler);

    const unhandled = await recordUnhandled(async () => {
      bus.emit(event);
      await observerEntered.promise;
      releaseObserver.resolve();
    });

    expect(unhandled).toEqual([]);
    expect(observed).toHaveLength(1);
    expect(observed[0]?.handler).toBe(failedHandler);
  });
});
