/**
 * Extension loader — scans `.thread-phase/` and registers what it finds.
 *
 * Three discovery tiers, in order of complexity:
 *
 *   1. Loose `.ts` / `.js` file
 *        .thread-phase/triggers/cron-15m.ts
 *      The default export is `(api) => void`.
 *
 *   2. Folder with `index.ts` / `index.js`
 *        .thread-phase/triggers/my-webhook/index.ts
 *      Same contract; useful when the extension needs sibling files.
 *
 *   3. Folder with `package.json` carrying a `thread-phase.extensions` field
 *        .thread-phase/triggers/with-deps/package.json
 *      ```json
 *      { "name": "with-deps", "thread-phase": { "extensions": ["./index.ts"] } }
 *      ```
 *      Use this when the extension needs its own npm deps installed via
 *      an npm workspace inside `.thread-phase/`.
 *
 * Per-extension errors don't fail the whole load. The loader logs the
 * failing file's path and continues. Use `--strict` (later) to opt in
 * to fail-fast.
 *
 * TypeScript files are loaded via `tsx`'s programmatic API, so the CLI
 * itself runs as compiled JS but user extensions stay in `.ts`.
 */

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

import type { Registry } from './registry.js';
import type { ExtensionRegisterFn } from './types.js';

/**
 * Lazily install the tsx ESM hook once per process. Subsequent imports of
 * `.ts` files go through plain `import()` without per-file namespacing,
 * which lets transitive imports (e.g. `@autonome-research/thread-phase`)
 * resolve normally.
 */
let tsxHookInstalled = false;
function ensureTsxHook(): void {
  if (tsxHookInstalled) return;
  register();
  tsxHookInstalled = true;
}

/** Kinds of extensions the loader discovers. Order matters: triggers and adapters before pipelines, so pipeline bindings can resolve. */
export const EXTENSION_KINDS = ['triggers', 'adapters', 'pipelines'] as const;
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export interface LoadOptions {
  /** Project root containing `.thread-phase/`. Default: `process.cwd()`. */
  cwd?: string;
  /** Stop on first error. Default: false (per-file isolation). */
  strict?: boolean;
  /** Log function. Default: console.error (stderr). */
  log?: (message: string) => void;
}

export interface LoadResult {
  /** Paths loaded successfully. */
  loaded: string[];
  /** Errors keyed by path. */
  errors: Array<{ path: string; error: Error }>;
}

const PKG_FIELD = 'thread-phase';

export async function loadExtensions(
  registry: Registry,
  options: LoadOptions = {},
): Promise<LoadResult> {
  const cwd = options.cwd ?? process.cwd();
  const log = options.log ?? ((m: string) => console.error(m));
  const root = join(cwd, '.thread-phase');

  const result: LoadResult = { loaded: [], errors: [] };

  if (!existsSync(root)) {
    return result; // no extensions; nothing to load (not an error)
  }

  for (const kind of EXTENSION_KINDS) {
    const kindDir = join(root, kind);
    if (!existsSync(kindDir)) continue;

    const paths = discoverExtensionPaths(kindDir);
    for (const path of paths) {
      try {
        await loadOne(path, registry);
        result.loaded.push(path);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        result.errors.push({ path, error });
        if (options.strict) throw error;
        log(`[thread-phase] failed to load ${path}: ${error.message}`);
      }
    }
  }

  return result;
}

export function discoverExtensionPaths(kindDir: string): string[] {
  const entries = readdirSync(kindDir).sort();
  const paths: string[] = [];

  for (const entry of entries) {
    const full = join(kindDir, entry);
    const st = statSync(full);

    // Tier 1: loose .ts / .js
    if (st.isFile() && (entry.endsWith('.ts') || entry.endsWith('.js'))) {
      paths.push(full);
      continue;
    }

    if (!st.isDirectory()) continue;

    // Tier 3: package.json with `thread-phase.extensions`
    const pkgPath = join(full, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
          [PKG_FIELD]?: { extensions?: string[] };
        };
        const declared = pkg[PKG_FIELD]?.extensions;
        if (Array.isArray(declared)) {
          for (const rel of declared) {
            paths.push(resolve(full, rel));
          }
          continue;
        }
      } catch {
        // Fall through to tier 2 if package.json is malformed.
      }
    }

    // Tier 2: folder with index.ts / index.js
    const indexTs = join(full, 'index.ts');
    const indexJs = join(full, 'index.js');
    if (existsSync(indexTs)) {
      paths.push(indexTs);
    } else if (existsSync(indexJs)) {
      paths.push(indexJs);
    }
  }

  return paths;
}

async function loadOne(path: string, registry: Registry): Promise<void> {
  if (path.endsWith('.ts')) ensureTsxHook();

  const url = pathToFileURL(path).href;
  const mod = (await import(url)) as {
    default?: ExtensionRegisterFn | { default?: ExtensionRegisterFn };
  };

  // Handle the ESM/CJS interop case where tsx transpiles to CJS and the
  // dynamic import wraps `module.exports` under `default`. In that shape,
  // the user's `export default fn` becomes `mod.default.default`.
  let registerFn: ExtensionRegisterFn | undefined;
  if (typeof mod.default === 'function') {
    registerFn = mod.default;
  } else if (
    mod.default !== null &&
    typeof mod.default === 'object' &&
    typeof mod.default.default === 'function'
  ) {
    registerFn = mod.default.default;
  }

  if (typeof registerFn !== 'function') {
    throw new Error(
      `extension at ${path} has no default export of shape (api) => void`,
    );
  }

  registry.currentSource = path;
  try {
    await registerFn(registry);
  } finally {
    registry.currentSource = '<unknown>';
  }
}
