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
export declare function toErrorMessage(err: unknown): string;
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
export declare function signalReasonToString(signal: AbortSignal, fallback?: string): string;
//# sourceMappingURL=error-message.d.ts.map