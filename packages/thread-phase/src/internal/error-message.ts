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
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  // Object with a string-ish `.message` field — the common shape for
  // SDK errors and wrapped throws across the JS ecosystem.
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return safeStringify(err);
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
