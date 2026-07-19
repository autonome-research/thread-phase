/**
 * match — keyed dispatch over phases.
 *
 * Routes to one of N phase lists based on a selector function. Generalizes
 * if/else (use two cases) and replaces ad-hoc switch statements in pipeline
 * code with a primitive the orchestrator can reason about.
 *
 * The selector returns one of three things:
 *  - a key present in `cases`             → run that case's phases
 *  - a key missing from `cases`           → run `default` if provided, else skip
 *  - `null`                               → skip silently (no case, no default)
 *
 * Emits a `data` event with key `${name}.taken` and value
 * `{ taken: key | 'default' | 'skip' }` so downstream consumers can tell
 * which arm ran without inspecting the selector themselves.
 *
 * Strict dispatch is the caller's responsibility — assert inside the
 * selector if a missing key should be a bug.
 */
import type { BasePipelineContext, Phase } from '../phase.js';
export interface MatchOptions<TCtx extends BasePipelineContext, K extends string> {
    /** Returns the key of the case to run, or null to skip. */
    selector: (ctx: TCtx) => K | null | Promise<K | null>;
    /** Phase lists keyed by case. */
    cases: Record<K, Phase<TCtx>[]>;
    /** Fallback phases when selector returns a key not in `cases`. */
    default?: Phase<TCtx>[];
}
export declare function match<TCtx extends BasePipelineContext, K extends string>(phaseName: string, options: MatchOptions<TCtx, K>): Phase<TCtx>;
//# sourceMappingURL=match.d.ts.map