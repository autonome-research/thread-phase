import type { Trigger, TriggerEvent } from '@autonome-research/thread-phase/triggers';
import type { ThreadPhaseAPI } from '@autonome-research/thread-phase-cli';

/**
 * Trigger that yields one event immediately, then idles. Its `stop()`
 * waits 300ms before resolving, giving tests a window in which to
 * observe the "shutting down" state of a health endpoint.
 */
class SlowStopTrigger implements Trigger<void> {
  readonly name = 'slow-stop';
  private stopping = false;
  private resolveIdle: (() => void) | undefined;

  async *start(): AsyncGenerator<TriggerEvent<void>, void> {
    // Yield a single event then idle until stop() is called.
    yield {
      id: 1,
      occurredAt: new Date().toISOString(),
      input: undefined,
    };
    if (this.stopping) return;
    await new Promise<void>((resolve) => {
      this.resolveIdle = resolve;
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // Hold the stop for a beat so the health endpoint can be observed
    // in the `shutting_down` state.
    await new Promise((r) => setTimeout(r, 300));
    this.resolveIdle?.();
  }
}

export default (api: ThreadPhaseAPI) => {
  api.registerTrigger('slow-stop', new SlowStopTrigger());
};
