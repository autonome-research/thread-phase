/**
 * Error classification for the agent loop. Two questions:
 *  - is this error retryable (transient network / overloaded backend)?
 *  - is this error a cancellation we should respect rather than retry?
 *
 * Tuned for OpenAI-compat endpoints (vLLM, OpenAI, Ollama) — they all use
 * roughly the same surface for transient failures.
 *
 * @internal — both predicates are exported for advanced callers wrapping
 * the runner with their own retry/abort logic, but they are not part of
 * the v1 stable surface. They may change as we discover new failure modes.
 */

export function isRetryableError(err: unknown): boolean {
  const e = err as { message?: string; status?: number; statusCode?: number; name?: string } | null;
  // Never retry on cancellation — the caller asked us to stop.
  if (e?.name === 'AbortError') return false;
  const message = e?.message ?? '';
  const status = e?.status ?? e?.statusCode ?? 0;
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes('timeout') ||
    message.includes('ECONNRESET') ||
    message.includes('ECONNREFUSED') ||
    message.includes('overloaded') ||
    message.includes('rate_limit')
  );
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === 'AbortError' || (e?.message ?? '').includes('aborted');
}
