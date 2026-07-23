/**
 * @internal — tolerant extraction of a string message from any thrown value.
 *
 * `try/catch` in TypeScript types the caught binding as `unknown`. Hot paths
 * (agent runner, adapter shells, telemetry hooks) need a string to log, but
 * casting to `{ message?: string }` is a quiet lie — it silences the
 * compiler without checking what `err` actually is. When upstream code
 * throws a string, a primitive, or an object whose `.message` is not a
 * string, downstream `.slice()`/`.includes()`/etc. crash inside the error
 * reporter and mask the original failure.
 *
 * Use this helper anywhere we need a string out of `unknown`:
 *   catch (err) {
 *     log({ detail: toErrorMessage(err).slice(0, 200) });
 *   }
 *
 * Mirrors the safety contract of agents/serialize-error.ts: MUST NOT throw.
 */

export function toErrorMessage(err: unknown): string {
  try {
    if (err instanceof Error) {
      const message: unknown = err.message;
      if (typeof message === 'string') return message;
    }
  } catch {
    // Hostile proxies may throw from instanceof or message access.
  }
  if (typeof err === 'string') {
    return err;
  }
  // Object with a string-ish `.message` field — the common shape for
  // SDK errors and wrapped throws across the JS ecosystem.
  if (typeof err === 'object' && err !== null) {
    try {
      const m = (err as { message?: unknown }).message;
      if (typeof m === 'string') return m;
    } catch {
      // Proxies and hostile accessors must fall through to safe stringification.
    }
  }
  return safeStringify(err);
}

/**
 * Coerce `AbortSignal.reason` to a string for logging or event payloads.
 *
 * `AbortSignal.reason` is typed `any` per the WHATWG spec — most callers
 * pass strings, many pass `Error` instances, SDKs occasionally pass
 * arbitrary objects, and `undefined` is the default before any explicit
 * `controller.abort(reason)`. This helper centralizes the coercion so
 * the orchestrator, JobRunner, and any future call site agree on the
 * contract and `undefined` consistently means "no reason given."
 *
 * @param signal The AbortSignal whose `reason` to coerce.
 * @param fallback String to return when `signal.reason` is undefined.
 *                 Defaults to `'aborted'`.
 */
export function toError(err: unknown): Error {
  try {
    if (err instanceof Error) {
      // Preserve identity only for ordinary, safely inspectable Errors. A Proxy
      // can pass instanceof while throwing from any later diagnostic access.
      const message: unknown = err.message;
      const name: unknown = err.name;
      const stack: unknown = err.stack;
      if (
        typeof message === 'string' &&
        typeof name === 'string' &&
        (stack === undefined || typeof stack === 'string')
      ) {
        return err;
      }
    }
  } catch {
    // Hostile proxies and accessors are cloned into a plain Error below.
  }
  return new Error(toErrorMessage(err));
}

export function signalReasonToString(
  signal: AbortSignal,
  fallback = 'aborted',
): string {
  return signal.reason === undefined ? fallback : toErrorMessage(signal.reason);
}

/**
 * Stringify an arbitrary value without ever propagating an exception.
 * Hostile inputs — Proxies whose traps throw, objects with throwing
 * `Symbol.toPrimitive` or `toString` — would otherwise crash this function.
 *
 * Duplicates the helper in agents/serialize-error.ts intentionally: that
 * one is internal to error serialization; this module is internal to
 * message extraction. Both must be standalone safety nets.
 */
function safeStringify(v: unknown): string {
  try {
    return String(v);
  } catch {
    try {
      return Object.prototype.toString.call(v);
    } catch {
      return '<unserializable>';
    }
  }
}
