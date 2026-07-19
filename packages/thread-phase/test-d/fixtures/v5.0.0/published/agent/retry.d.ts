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
export declare function isRetryableError(err: unknown): boolean;
export declare function isAbortError(err: unknown): boolean;
//# sourceMappingURL=retry.d.ts.map