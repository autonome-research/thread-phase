/**
 * `oneShot` — register a single-handler pipeline with no trigger binding.
 *
 * Compresses the common "I have a one-off task I want to invoke via
 * `thread-phase run <name>`" case to a single function call. The handler
 * runs as a one-phase pipeline; its return value is captured as a `data`
 * event with key `${name}.result`.
 *
 * Example:
 *
 *   export default oneShot(async (ctx) => {
 *     await fireAndForget();
 *     return { ok: true };
 *   });
 *
 * If `name` is omitted, the helper derives it from the basename of the
 * calling file. For production code prefer passing an explicit `name`.
 */
import type { ExtensionRegisterFn, HelperHandler } from './types.js';
export interface OneShotOptions {
    /** Pipeline name. If omitted, derived from the calling file's basename. */
    name?: string;
    /** Free-form description for `thread-phase list`. */
    description?: string;
}
export declare function oneShot<TResult = unknown>(handler: HelperHandler<unknown, TResult>, options?: OneShotOptions): ExtensionRegisterFn;
//# sourceMappingURL=one-shot.d.ts.map