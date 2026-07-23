/**
 * Multi-subscriber event bus for cross-adapter observation.
 *
 * Plain pub/sub with synchronous emission and best-effort handler dispatch.
 * Handler errors are isolated so a misbehaving subscriber can't poison the
 * stream for the rest. Async handlers are fire-and-forget (no awaiting); use
 * the bus for observation, not for sequencing. Subscriber failures can be
 * observed through `onHandlerError`.
 *
 */

import { toError } from '../internal/error-message.js';
import type {
  AgentEvent,
  AgentEventHandler,
  AgentEventHandlerFailure,
  ObservableAgentEventBus,
} from './protocol.js';

/**
 * Construct a new event bus. Each adapter that receives one via
 * `AgentRunOptions.eventBus` mirrors its event stream into it.
 *
 */
export function createEventBus(): ObservableAgentEventBus {
  const handlers = new Set<AgentEventHandler>();
  const errorHandlers = new Set<
    (failure: AgentEventHandlerFailure) => void | Promise<void>
  >();

  const reportHandlerError = (
    handler: AgentEventHandler,
    event: AgentEvent,
    error: unknown,
  ): void => {
    const failure: AgentEventHandlerFailure = Object.freeze({
      handler,
      event,
      error: toError(error),
    });
    for (const observer of [...errorHandlers]) {
      try {
        void Promise.resolve(observer(failure)).catch(() => {});
      } catch {
        // Error observers are a terminal sink: never recursively report them.
      }
    }
  };

  return {
    emit(event) {
      // Snapshot subscriptions so add/remove operations during dispatch affect
      // only later events, never the event currently being fanned out.
      for (const handler of [...handlers]) {
        try {
          void Promise.resolve(handler(event)).catch((error: unknown) => {
            reportHandlerError(handler, event, error);
          });
        } catch (error) {
          reportHandlerError(handler, event, error);
        }
      }
    },
    on(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onHandlerError(handler) {
      errorHandlers.add(handler);
      return () => {
        errorHandlers.delete(handler);
      };
    },
  };
}
