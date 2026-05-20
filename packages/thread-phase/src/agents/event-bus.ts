/**
 * Multi-subscriber event bus for cross-adapter observation.
 *
 * Plain pub/sub with synchronous emission and best-effort handler dispatch.
 * Handler errors are swallowed so a misbehaving subscriber can't poison the
 * stream for the rest — subscribers handle their own errors. Async handlers
 * are fire-and-forget (no awaiting); use the bus for observation, not for
 * sequencing.
 *
 * @internal
 */

import type { AgentEvent, AgentEventBus } from './protocol.js';

/**
 * Construct a new event bus. Each adapter that receives one via
 * `AgentRunOptions.eventBus` mirrors its event stream into it.
 *
 * @internal
 */
export function createEventBus(): AgentEventBus {
  const handlers = new Set<(event: AgentEvent) => void | Promise<void>>();
  return {
    emit(event) {
      for (const h of handlers) {
        try {
          void h(event);
        } catch {
          // Handler errors are intentionally swallowed; downstream consumers
          // handle their own errors so one bad subscriber can't stall the bus.
        }
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
  };
}
