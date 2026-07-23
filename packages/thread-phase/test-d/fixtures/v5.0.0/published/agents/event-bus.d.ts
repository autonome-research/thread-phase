/**
 * Multi-subscriber event bus for cross-adapter observation.
 *
 * Plain pub/sub with synchronous emission and best-effort handler dispatch.
 * Handler errors are swallowed so a misbehaving subscriber can't poison the
 * stream for the rest — subscribers handle their own errors. Async handlers
 * are fire-and-forget (no awaiting); use the bus for observation, not for
 * sequencing.
 *
 */
import type { AgentEventBus } from './protocol.js';
/**
 * Construct a new event bus. Each adapter that receives one via
 * `AgentRunOptions.eventBus` mirrors its event stream into it.
 *
 */
export declare function createEventBus(): AgentEventBus;
//# sourceMappingURL=event-bus.d.ts.map