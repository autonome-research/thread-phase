/**
 * Convert a thrown value into the wire-friendly `SerializableError` shape
 * that adapters emit on `error` events. Walks the `cause` chain so wrapped
 * errors don't lose context across the subprocess boundary.
 *
 * Contract: MUST NOT throw — adapters call this on every error before
 * emitting an `error` event, so a throw here would crash the adapter
 * harness instead of producing the documented payload.
 *
 * @internal
 */

import { toErrorMessage } from '../internal/error-message.js';
import type { SerializableError } from './protocol.js';

/**
 * Normalize any thrown value to a `SerializableError`. Non-`Error` throws
 * become `{ name: 'NonError', message: <stringified> }` so the field shape
 * stays uniform — consumers can rely on `name` and `message` always being
 * present.
 *
 * Cycles in `Error.cause` chains (which can occur in real code via wrapped
 * errors that re-reference the original) are detected via a visited set
 * and surface as `{ name: 'CycleDetected', ... }` instead of recursing
 * past the JS stack limit.
 *
 * @internal
 */
export function serializeError(err: unknown): SerializableError {
  return serializeInner(err, new WeakSet<object>());
}

function serializeInner(
  err: unknown,
  seen: WeakSet<object>,
): SerializableError {
  try {
    if (err instanceof Error) {
      if (seen.has(err)) {
        return {
          name: 'CycleDetected',
          message: `cyclic Error.cause reference back to ${err.name}: ${err.message}`,
        };
      }
      seen.add(err);
      return {
        name: err.name,
        message: err.message,
        stack: err.stack,
        cause:
          err.cause !== undefined ? serializeInner(err.cause, seen) : undefined,
      };
    }
  } catch {
    // Hostile proxies and Error accessors fall through to safe normalization.
  }
  return { name: 'NonError', message: toErrorMessage(err) };
}
