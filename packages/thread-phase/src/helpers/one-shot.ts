/**
 * `oneShot` — register a single-handler pipeline with no trigger binding.
 *
 * Compresses the common "I have a one-off task I want to invoke via
 * `thread-phase run <name>`" case to a single function call. The handler
 * runs as a one-phase pipeline; its return value is captured as a `data`
 * event with key `${name}.result`. The parsed `--input` value (or the
 * dispatching trigger's payload) arrives as the handler's first argument —
 * `undefined` when the caller passed none.
 *
 * Example:
 *
 *   export default oneShot(async (input, ctx) => {
 *     await fireAndForget(input);
 *     return { ok: true };
 *   });
 *
 * If `name` is omitted, the helper derives it from the basename of the
 * calling file. For production code prefer passing an explicit `name`.
 */

import { PipelineCache } from '../cache.js';
import type { BasePipelineContext, Phase } from '../phase.js';
import { deriveNameFromCaller } from './caller.js';
import type {
  ExtensionRegisterFn,
  HelperHandler,
  PipelineSpec,
} from './types.js';

export interface OneShotOptions {
  /** Pipeline name. If omitted, derived from the calling file's basename. */
  name?: string;
  /** Free-form description for `thread-phase list`. */
  description?: string;
}

export function oneShot<TResult = unknown>(
  handler: HelperHandler<unknown, TResult>,
  options: OneShotOptions = {},
): ExtensionRegisterFn {
  const name = options.name ?? deriveNameFromCaller('oneShot');

  // Factory form, not a static array: the dispatcher resolves
  // `spec.phases(input, event)` per run, which is the only way the
  // `--input` value can reach the handler.
  const makePhase = (input: unknown): Phase<BasePipelineContext> => ({
    name,
    async *run(ctx) {
      const result = await handler(input, ctx);
      yield {
        type: 'data',
        key: `${name}.result`,
        value: result,
      };
    },
  });

  const spec: PipelineSpec<BasePipelineContext, unknown> = {
    phases: (input) => [makePhase(input)],
    ctx: () => ({ cache: new PipelineCache() }),
    description: options.description,
  };

  return (api) => {
    api.registerPipeline(name, spec);
  };
}
