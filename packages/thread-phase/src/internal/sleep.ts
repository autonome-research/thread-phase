/**
 * @internal — shared abortable-sleep helper.
 *
 * Replaces `new Promise(r => setTimeout(r, ms))` everywhere a delay needs to
 * honor an `AbortSignal`. Without this, cancellation has to wait for the
 * full delay before surfacing — which makes retry backoffs, timer polling,
 * and structured backoff loops un-cancellable in practice.
 *
 * Rejects with a `DOMException(name: 'AbortError')` when the signal aborts.
 * Resolves normally when the timer elapses. Cleans up its listener in both
 * paths so signals attached to long-lived AbortControllers don't leak.
 *
 * Not exported from the package surface. Pattern wrappers (with-retry,
 * timer-trigger, agent runner) consume it directly.
 */

import { toError, toErrorMessage } from './error-message.js';

export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(toAbortError(signal.reason));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(toAbortError(signal?.reason));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function toAbortError(reason: unknown): Error {
  const normalized = toError(reason);
  const message = typeof reason === 'string'
    ? reason
    : normalized === reason
      ? toErrorMessage(normalized)
      : 'aborted';
  // Prefer the native DOMException(AbortError) so callers using
  // `e.name === 'AbortError'` (the platform idiom) keep working.
  if (typeof DOMException === 'function') {
    return new DOMException(message, 'AbortError');
  }
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}
