/**
 * TimerTrigger — interval-based concrete Trigger.
 */

import { describe, it, expect } from 'vitest';
import { TimerTrigger } from '../src/triggers/timer-trigger.js';
import type { TriggerEvent } from '../src/triggers/types.js';

describe('TimerTrigger', () => {
  it('fires after each interval and yields incrementing ids', async () => {
    const trigger = new TimerTrigger({ intervalMs: 20 });
    const events: TriggerEvent<void>[] = [];

    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 75); // 3 fires expected

    for await (const ev of gen) events.push(ev);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.length).toBeLessThanOrEqual(4);
    expect(events.map((e) => e.id)).toEqual(events.map((_, i) => i + 1));
  });

  it('fireImmediately produces the first event without delay', async () => {
    const trigger = new TimerTrigger({
      intervalMs: 1000,
      fireImmediately: true,
    });
    const events: TriggerEvent<void>[] = [];

    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 25);

    for await (const ev of gen) events.push(ev);

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe(1);
  });

  it('payload literal is attached to each event', async () => {
    const trigger = new TimerTrigger<{ tag: string }>({
      intervalMs: 15,
      payload: { tag: 'hello' },
    });
    const events: TriggerEvent<{ tag: string }>[] = [];

    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 40);

    for await (const ev of gen) events.push(ev);

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.input).toEqual({ tag: 'hello' });
  });

  it('payload factory is called per fire', async () => {
    let n = 0;
    const trigger = new TimerTrigger<number>({
      intervalMs: 15,
      payload: () => ++n,
    });
    const events: TriggerEvent<number>[] = [];

    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 50);

    for await (const ev of gen) events.push(ev);

    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map((e) => e.input)).toEqual(
      events.map((_, i) => i + 1),
    );
  });

  it('async payload factory is awaited', async () => {
    const trigger = new TimerTrigger<string>({
      intervalMs: 15,
      payload: async () => {
        await new Promise<void>((r) => setTimeout(r, 1));
        return 'async';
      },
    });
    const events: TriggerEvent<string>[] = [];

    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 30);

    for await (const ev of gen) events.push(ev);

    for (const ev of events) {
      expect(ev.input).toBe('async');
    }
  });

  it('stop() exits the generator within ~one interval', async () => {
    const trigger = new TimerTrigger({ intervalMs: 50 });
    const events: TriggerEvent<void>[] = [];

    const gen = trigger.start();
    const start = Date.now();
    setTimeout(() => void trigger.stop(), 5);

    for await (const ev of gen) events.push(ev);
    const elapsed = Date.now() - start;

    expect(events).toEqual([]);
    expect(elapsed).toBeLessThan(40); // shouldn't wait the full 50ms interval
  });

  it('stop() is idempotent', async () => {
    const trigger = new TimerTrigger({ intervalMs: 50 });
    const gen = trigger.start();
    void (async () => {
      for await (const _ of gen) void _;
    })();
    await trigger.stop();
    await trigger.stop();
    await trigger.stop();
    // No assertion — just confirms no throw.
  });

  it('start() after stop() returns immediately', async () => {
    const trigger = new TimerTrigger({ intervalMs: 50 });
    await trigger.stop();

    const events: TriggerEvent<void>[] = [];
    for await (const ev of trigger.start()) events.push(ev);

    expect(events).toEqual([]);
  });

  it('default name is timer:<ms>ms', () => {
    const t = new TimerTrigger({ intervalMs: 250 });
    expect(t.name).toBe('timer:250ms');
  });

  it('custom name overrides default', () => {
    const t = new TimerTrigger({ intervalMs: 250, name: 'morning-digest' });
    expect(t.name).toBe('morning-digest');
  });

  it('events carry ISO-8601 occurredAt', async () => {
    const trigger = new TimerTrigger({ intervalMs: 10 });
    const gen = trigger.start();
    setTimeout(() => void trigger.stop(), 25);

    const events: TriggerEvent<void>[] = [];
    for await (const ev of gen) events.push(ev);

    expect(events[0]?.occurredAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/,
    );
  });
});
