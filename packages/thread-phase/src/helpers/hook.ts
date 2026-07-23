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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { PipelineCache } from '../cache.js';
import type { BasePipelineContext, Phase } from '../phase.js';
import type { Trigger, TriggerEvent } from '../triggers/types.js';
import { deriveNameFromCaller } from './caller.js';
import { toError, toErrorMessage } from '../internal/error-message.js';
import type {
  ExtensionRegisterFn,
  HelperHandler,
  PipelineSpec,
} from './types.js';

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
export class HookValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'HookValidationError';
  }
}

/**
 * Shape returned by `hook` handlers — coerced to JSON in the HTTP
 * response. Pending payloads are tracked here so the response can be
 * resolved once the pipeline phase finishes invoking the handler.
 */
type PendingResponse = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

/**
 * Internal state for the shared HTTP server. One per process — refcounted
 * so tests (and short-lived `run` invocations) can reset it cleanly.
 */
interface SharedServer {
  server: Server;
  routes: Map<string, HttpTrigger>;
  started: boolean;
  startPromise?: Promise<void>;
  port: number;
}

let shared: SharedServer | undefined;

function getSharedServer(): SharedServer {
  if (shared) return shared;
  const port = Number(process.env.THREAD_PHASE_HTTP_PORT ?? 7777);
  const routes = new Map<string, HttpTrigger>();
  const server = createServer((req, res) => handleRequest(req, res, routes));
  shared = { server, routes, started: false, port };
  return shared;
}

/**
 * Tear down the shared HTTP server. Normally called automatically by the
 * last HttpTrigger.stop() (via refcount) — exposed for tests that need a
 * force teardown mid-suite or for atexit hooks.
 */
async function closeSharedServer(): Promise<void> {
  if (!shared) return;
  const toClose = shared;
  shared = undefined;
  await new Promise<void>((resolve) => {
    toClose.server.close(() => resolve());
  });
}

/** Test-only: tear down the shared server so each test starts clean. */
export function _resetHttpServerForTests(): void {
  if (!shared) return;
  try {
    shared.server.close();
  } catch {
    // ignore
  }
  shared = undefined;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routes: Map<string, HttpTrigger>,
): Promise<void> {
  const url = req.url ?? '/';
  const path = url.split('?')[0] ?? url;
  const route = routes.get(path);

  if (!route) {
    res.statusCode = 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: `no hook registered at ${path}` }));
    return;
  }

  if ((req.method ?? '').toUpperCase() !== 'POST') {
    res.statusCode = 405;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: 'method not allowed' }));
    return;
  }

  let raw = '';
  for await (const chunk of req) {
    raw += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  }
  let body: unknown = undefined;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }
  }

  try {
    const result = await route.dispatch(body);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(result ?? null));
  } catch (err) {
    // Errors carrying a numeric `statusCode` (e.g. HookValidationError)
    // propagate their intended HTTP status; anything else is treated as a
    // generic server error. Message extraction goes through toErrorMessage
    // so non-Error throws don't produce `undefined` payloads.
    const statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
    res.statusCode = statusCode;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({ error: toErrorMessage(err) || 'internal error' }),
    );
  }
}

// ---------------------------------------------------------------------------
// HttpTrigger — one per registered hook. Yields TriggerEvents as inbound
// requests arrive on its `path`. Production wiring (pipeline + handler)
// happens via the trigger's consumer (`runTrigger`); the response is
// settled by `route.dispatch` once the handler has finished.
// ---------------------------------------------------------------------------

export class HttpTrigger implements Trigger<unknown> {
  readonly name: string;
  readonly path: string;
  readonly method: 'POST';
  /** @internal — exposed for tests asserting the shared-server invariant. */
  readonly _server: Server;

  private seq = 0;
  private stopped = false;
  private queued: Array<{
    event: TriggerEvent<unknown>;
    pending: PendingResponse;
  }> = [];
  private waiter: ((value: void) => void) | null = null;
  private readonly shared: SharedServer;
  /** Map event.id → pending response so the handler's return value can be sent back. */
  private readonly pendingById = new Map<number, PendingResponse>();
  /** Map event.id → user handler's return value (so dispatch can resolve sync). */
  private readonly resultsById = new Map<number, unknown>();

  constructor(opts: { name: string; path: string; method: 'POST' }) {
    this.name = opts.name;
    this.path = opts.path;
    this.method = opts.method;
    this.shared = getSharedServer();
    this._server = this.shared.server;
  }

  /**
   * Called by the shared HTTP handler. Enqueues a new event and returns
   * a promise that resolves with the user handler's return value.
   */
  async dispatch(body: unknown): Promise<unknown> {
    const event: TriggerEvent<unknown> = {
      id: ++this.seq,
      occurredAt: new Date().toISOString(),
      input: body,
    };
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingResponse = { resolve, reject };
      this.queued.push({ event, pending });
      this.pendingById.set(event.id, pending);
      this.waiter?.();
      this.waiter = null;
    });
  }

  /**
   * Resolve the pending HTTP response for a given event id. Called by the
   * helper-generated Phase once the user handler has returned.
   */
  resolveResponse(eventId: number, value: unknown): void {
    const pending = this.pendingById.get(eventId);
    if (!pending) return;
    this.pendingById.delete(eventId);
    pending.resolve(value);
  }

  /** Reject the pending HTTP response for a given event id. */
  rejectResponse(eventId: number, err: Error): void {
    const pending = this.pendingById.get(eventId);
    if (!pending) return;
    this.pendingById.delete(eventId);
    pending.reject(err);
  }

  async *start(): AsyncGenerator<TriggerEvent<unknown>, void> {
    await this.ensureServerStarted();
    while (!this.stopped) {
      if (this.queued.length === 0) {
        await new Promise<void>((resolve) => {
          this.waiter = resolve;
        });
        if (this.stopped) return;
      }
      const item = this.queued.shift();
      if (!item) continue;
      yield item.event;
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.waiter?.();
    this.waiter = null;
    for (const pending of this.pendingById.values()) {
      pending.reject(new Error('hook stopped'));
    }
    this.pendingById.clear();
    this.shared.routes.delete(this.path);
    // Refcount: when the last registered hook removes its route, tear down
    // the shared HTTP server so the port is released and the process can
    // exit cleanly. _resetHttpServerForTests remains as a force-teardown
    // escape hatch for tests that need to reset mid-suite.
    if (this.shared.routes.size === 0 && this.shared.started) {
      await closeSharedServer();
    }
  }

  private async ensureServerStarted(): Promise<void> {
    this.shared.routes.set(this.path, this);
    if (this.shared.started) return;
    if (this.shared.startPromise) {
      await this.shared.startPromise;
      return;
    }
    this.shared.startPromise = new Promise<void>((resolve, reject) => {
      this.shared.server.once('error', reject);
      this.shared.server.listen(this.shared.port, '127.0.0.1', () => {
        this.shared.started = true;
        resolve();
      });
    });
    await this.shared.startPromise;
  }
}

// ---------------------------------------------------------------------------
// hook() — the public entry point.
// ---------------------------------------------------------------------------

export function hook<TBody = unknown, TResult = unknown>(
  spec: HookSpec,
  handler: HelperHandler<TBody, TResult>,
  options: HookOptions<TBody> = {},
): ExtensionRegisterFn {
  const name = options.name ?? deriveNameFromCaller('hook');
  const triggerName = `${name}:http`;
  const method: 'POST' = spec.method ?? 'POST';

  const trigger = new HttpTrigger({ name: triggerName, path: spec.path, method });

  const phase: Phase<BasePipelineContext> = {
    name,
    async *run(ctx) {
      const carrier = ctx as BasePipelineContext & {
        __triggerEvent?: TriggerEvent<unknown>;
        __httpTrigger?: HttpTrigger;
      };
      const event = carrier.__triggerEvent;
      const httpTrig = carrier.__httpTrigger ?? trigger;
      const eventId = event?.id ?? 0;

      // Trust boundary: webhook bodies arrive as `unknown`. If the caller
      // provided a `validate` function, parse-don't-assert; on validation
      // failure surface a 400 by wrapping in HookValidationError. When no
      // validator is provided, fall back to the historical cast — unsafe
      // but documented (see HookOptions.validate).
      let body: TBody;
      if (options.validate) {
        try {
          body = options.validate(event?.input);
        } catch (validationErr) {
          const wrapped = validationErr instanceof HookValidationError
            ? validationErr
            : new HookValidationError(toErrorMessage(validationErr), {
                cause: validationErr,
              });
          httpTrig.rejectResponse(eventId, wrapped);
          throw wrapped;
        }
      } else {
        body = event?.input as TBody;
      }

      try {
        const result = await handler(body, ctx);
        httpTrig.resolveResponse(eventId, result);
        yield {
          type: 'data',
          key: `${name}.result`,
          value: result,
        };
      } catch (err) {
        httpTrig.rejectResponse(
          eventId,
          toError(err),
        );
        throw err;
      }
    },
  };

  const pipelineSpec: PipelineSpec<BasePipelineContext, unknown> = {
    phases: [phase],
    ctx: (_input, event) => {
      const ctx: BasePipelineContext & {
        __triggerEvent?: TriggerEvent<unknown>;
        __httpTrigger?: HttpTrigger;
      } = { cache: new PipelineCache() };
      ctx.__triggerEvent = event;
      ctx.__httpTrigger = trigger;
      return ctx;
    },
    trigger: triggerName,
    description: options.description,
  };

  return (api) => {
    api.registerTrigger(triggerName, trigger);
    api.registerPipeline(name, pipelineSpec);
  };
}
