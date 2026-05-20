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

import { basename } from 'node:path';

const HELPER_FILE_MATCHERS = [
  'helpers/one-shot',
  'helpers/schedule',
  'helpers/hook',
  'helpers/caller',
  'helpers/index',
];

/**
 * Returns a slug-y name derived from the calling file (the first stack
 * frame that isn't inside `helpers/`). Falls back to `fallback` if no
 * usable frame is found.
 */
export function deriveNameFromCaller(fallback: string): string {
  const stack = new Error().stack ?? '';
  const lines = stack.split('\n').slice(1);

  for (const line of lines) {
    const match = line.match(/\(?(\/[^):\s]+\.(?:ts|js|mts|mjs|cjs))(?::\d+)?(?::\d+)?\)?/);
    if (!match) continue;
    const path = match[1]!;
    if (HELPER_FILE_MATCHERS.some((m) => path.includes(m))) continue;
    const base = basename(path).replace(/\.(ts|js|mts|mjs|cjs)$/, '');
    return base;
  }
  return fallback;
}
