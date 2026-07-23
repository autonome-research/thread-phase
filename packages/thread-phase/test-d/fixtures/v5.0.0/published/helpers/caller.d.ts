/**
 * Best-effort name derivation from the calling file's path.
 *
 * Walks the captured stack and returns the basename of the first frame
 * outside this `helpers/` directory. Used by `oneShot` / `schedule` /
 * `hook` to auto-name registrations when the caller didn't pass one.
 *
 * Pure heuristic — for production registrations the caller should pass
 * an explicit `name`. The stack-walk is fast and synchronous; the
 * helper file paths the matcher looks for are stable.
 */
/**
 * Returns a slug-y name derived from the calling file (the first stack
 * frame that isn't inside `helpers/`). Falls back to `fallback` if no
 * usable frame is found.
 */
export declare function deriveNameFromCaller(fallback: string): string;
//# sourceMappingURL=caller.d.ts.map