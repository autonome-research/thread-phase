import type {
  Questions,
  RequestOptions,
  SystemOneRequest,
  SystemOneResult,
} from '@typesafe-ai/sdk';
import type { BasePipelineContext, Phase } from './phase.js';

export interface SystemOneOptions<TCtx extends BasePipelineContext, Q extends Questions> {
  /** Host-owned SDK client; never stored on ctx or emitted in events. */
  client: {
    // PromiseLike avoids coupling to the SDK's nominal ESM/CJS APIPromise classes.
    systemOne<T extends Questions>(
      request: SystemOneRequest<T>, options?: RequestOptions,
    ): PromiseLike<SystemOneResult<T>>;
  };
  /** Select only the state to send, not the entire pipeline context. */
  request: (ctx: TCtx) => SystemOneRequest<Q> | Promise<SystemOneRequest<Q>>;
  /** SDK transport overrides. Cancellation is always owned by ctx.signal. */
  requestOptions?: Omit<RequestOptions, 'signal'>;
  /** Write typed results to ctx; may also set ctx.stop. Errors fail the phase. */
  onResult: (result: SystemOneResult<Q>, ctx: TCtx) => void | Promise<void>;
}

/**
 * TypeSafe System One evaluation as an ordinary pipeline phase.
 *
 * Use for named Choice, Score and Noul decisions followed by routing or gates.
 * Emits `${name}.result` with answers, model and usage after onResult succeeds.
 * The SDK owns request validation, transport, retries and per-attempt timeout; errors
 * propagate unchanged. No input state, questions or client config are emitted.
 *
 * Not for conversational agents or text generation. For a standalone evaluation
 * (including an intentGate classifier), call client.systemOne() directly.
 */
export function systemOne<TCtx extends BasePipelineContext, const Q extends Questions>(
  name: string,
  options: SystemOneOptions<TCtx, Q>,
): Phase<TCtx> {
  return {
    name,
    async *run(ctx) {
      const signal = ctx.signal;
      signal?.throwIfAborted();
      yield { type: 'phase', phase: name, detail: 'evaluating' };
      signal?.throwIfAborted();
      const request = await options.request(ctx);
      signal?.throwIfAborted();
      const result = await options.client.systemOne(request, {
        ...options.requestOptions,
        signal,
      });
      signal?.throwIfAborted();
      await options.onResult(result, ctx);
      signal?.throwIfAborted();
      yield {
        type: 'data',
        key: `${name}.result`,
        value: { answers: result.answers, model: result.model, usage: result.usage },
      };
    },
  };
}
