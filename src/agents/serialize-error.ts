/**
 * Convert a thrown value into the wire-friendly `SerializableError` shape
 * that adapters emit on `error` events. Walks the `cause` chain so wrapped
 * errors don't lose context across the subprocess boundary.
 *
 * @internal
 */

import type { SerializableError } from './protocol.js';

/**
 * Normalize any thrown value to a `SerializableError`. Non-`Error` throws
 * become `{ name: 'NonError', message: String(err) }` so the field shape
 * stays uniform — consumers can rely on `name` and `message` always being
 * present.
 *
 * @internal
 */
export function serializeError(err: unknown): SerializableError {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      cause: err.cause !== undefined ? serializeError(err.cause) : undefined,
    };
  }
  return { name: 'NonError', message: String(err) };
}
