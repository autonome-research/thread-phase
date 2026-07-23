/**
 * `hook` — register a pipeline driven by an inbound HTTP webhook.
 *
 *   export default hook({ path: '/webhook/digest' }, async (payload, ctx) => {
 *     return { ok: true, processed: payload };
 *   });
 *
 * The library maintains one `node:http` server per project — every `hook`
 * registration adds a new route to the same server. The server starts
 * lazily on the first `Trigger.start()`. Routes resolve by exact path
 * match; only POST with a JSON body is supported in v3.0.0.
 *
 * The handler is called with the parsed JSON body and ctx. Its return
 * value is JSON-serialized and sent back as the HTTP response body
 * (status 200). Throws produce status 500 with `{ error: message }`.
 *
 * Server port: `process.env.THREAD_PHASE_HTTP_PORT` if set, else 7777.
 */
import { type Server } from 'node:http';
import type { Trigger, TriggerEvent } from '../triggers/types.js';
import type { ExtensionRegisterFn, HelperHandler } from './types.js';
export interface HookSpec {
    /** URL path the webhook listens on. Exact match. */
    path: string;
    /** HTTP method. Only 'POST' is supported in v3.0.0. */
    method?: 'POST';
}
export interface HookOptions<TBody = unknown> {
    /** Pipeline + trigger base name. Defaults to the calling file's basename. */
    name?: string;
    /** Free-form description for `thread-phase list`. */
    description?: string;
    /**
     * Optional runtime validator for the incoming POST body.
     *
     * Webhook payloads are the canonical untrusted boundary — they come from
     * the network in arbitrary shapes. When `validate` is provided, the raw
     * JSON body is passed through it before reaching the handler; a throw
     * rejects the HTTP request with 400 and the thrown message.
     *
     * When absent, the body is cast to `TBody` without runtime checking —
     * the handler is one malformed POST away from a TypeError. Strongly
     * recommended to provide a validator (zod/valibot/io-ts/hand-written)
     * for any non-trusted source.
     *
     * Example:
     *   import { z } from 'zod';
     *   const Body = z.object({ slug: z.string(), count: z.number().int().min(0) });
     *   hook({ path: '/webhook' }, handler, { validate: (raw) => Body.parse(raw) });
     */
    validate?: (raw: unknown) => TBody;
}
/**
 * Error subclass that signals "the incoming body failed validation, return
 * 400 to the caller." The HTTP handler distinguishes this from generic
 * handler errors (which produce 500). Throw your own validation errors
 * wrapped in this class to surface a 400; bare throws from `validate` are
 * wrapped automatically.
 */
export declare class HookValidationError extends Error {
    readonly statusCode = 400;
    constructor(message: string, options?: {
        cause?: unknown;
    });
}
/** Test-only: tear down the shared server so each test starts clean. */
export declare function _resetHttpServerForTests(): void;
export declare class HttpTrigger implements Trigger<unknown> {
    readonly name: string;
    readonly path: string;
    readonly method: 'POST';
    /** @internal — exposed for tests asserting the shared-server invariant. */
    readonly _server: Server;
    private seq;
    private stopped;
    private queued;
    private waiter;
    private readonly shared;
    /** Map event.id → pending response so the handler's return value can be sent back. */
    private readonly pendingById;
    /** Map event.id → user handler's return value (so dispatch can resolve sync). */
    private readonly resultsById;
    constructor(opts: {
        name: string;
        path: string;
        method: 'POST';
    });
    /**
     * Called by the shared HTTP handler. Enqueues a new event and returns
     * a promise that resolves with the user handler's return value.
     */
    dispatch(body: unknown): Promise<unknown>;
    /**
     * Resolve the pending HTTP response for a given event id. Called by the
     * helper-generated Phase once the user handler has returned.
     */
    resolveResponse(eventId: number, value: unknown): void;
    /** Reject the pending HTTP response for a given event id. */
    rejectResponse(eventId: number, err: Error): void;
    start(): AsyncGenerator<TriggerEvent<unknown>, void>;
    stop(): Promise<void>;
    private ensureServerStarted;
}
export declare function hook<TBody = unknown, TResult = unknown>(spec: HookSpec, handler: HelperHandler<TBody, TResult>, options?: HookOptions<TBody>): ExtensionRegisterFn;
//# sourceMappingURL=hook.d.ts.map