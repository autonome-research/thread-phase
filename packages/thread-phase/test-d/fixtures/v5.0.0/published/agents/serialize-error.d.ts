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
export declare function serializeError(err: unknown): SerializableError;
//# sourceMappingURL=serialize-error.d.ts.map