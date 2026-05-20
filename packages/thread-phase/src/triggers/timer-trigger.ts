/**
 * TimerTrigger — fires at a fixed interval.
 *
 * The canonical scheduled-pipeline source. Replaces `setInterval(() => ..., 60_000)`
 * with the Trigger protocol so the same pipeline-dispatch code works for
 * timer-, webhook-, and queue-driven flows.
 *
 * No cron expression support in core — keep the impl tiny. For cron, wrap
 * a cron parser (e.g. `croner`) and produce events on its schedule;
 * `examples/triggers/timer-with-cron.ts` shows the shape.
 */

import type { Trigger, TriggerEvent } from './types.js';

export interface TimerTriggerOptions<TInput = void> {
  /** Interval between fires, in milliseconds. */
  intervalMs: number;
  /**
   * Payload to attach to each event. Defaults to `undefined`. If a
   * function, called each fire to produce a fresh payload (e.g. the
   * current time, a counter, a snapshot from somewhere).
   */
  payload?: TInput | (() => TInput) | (() => Promise<TInput>);
  /**
   * If true, fires immediately on `start()` before the first interval
   * elapses. Default: false (first event arrives after one interval).
   */
  fireImmediately?: boolean;
  /** Stable identifier used for logs. Default: `timer:${intervalMs}ms`. */
  name?: string;
}

export class TimerTrigger<TInput = void> implements Trigger<TInput> {
  readonly name: string;

  private readonly intervalMs: number;
  private readonly payload: TimerTriggerOptions<TInput>['payload'];
  private readonly fireImmediately: boolean;

  private seq = 0;
  private stopped = false;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private notifyStop: (() => void) | null = null;

  constructor(options: TimerTriggerOptions<TInput>) {
    this.intervalMs = options.intervalMs;
    this.payload = options.payload;
    this.fireImmediately = options.fireImmediately ?? false;
    this.name = options.name ?? `timer:${options.intervalMs}ms`;
  }

  async *start(): AsyncGenerator<TriggerEvent<TInput>, void> {
    if (this.stopped) return;

    if (this.fireImmediately) {
      yield await this.makeEvent();
      if (this.stopped) return;
    }

    while (!this.stopped) {
      const waited = await this.waitOrStop();
      if (!waited) return;
      yield await this.makeEvent();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.notifyStop?.();
    this.notifyStop = null;
  }

  private async makeEvent(): Promise<TriggerEvent<TInput>> {
    const input =
      typeof this.payload === 'function'
        ? await (this.payload as () => TInput | Promise<TInput>)()
        : (this.payload as TInput);

    return {
      id: ++this.seq,
      occurredAt: new Date().toISOString(),
      input,
    };
  }

  /** Returns true if the interval elapsed normally, false if stop() fired first. */
  private waitOrStop(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      this.pendingTimer = setTimeout(() => {
        this.pendingTimer = null;
        resolve(true);
      }, this.intervalMs);

      this.notifyStop = () => resolve(false);
    });
  }
}
