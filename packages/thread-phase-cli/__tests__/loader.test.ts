/**
 * Loader — extension discovery + registration.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Registry } from '../src/registry.js';
import {
  loadExtensions,
  discoverExtensionPaths,
  loadModule,
  normalizeModuleShape,
} from '../src/loader.js';

const fixtures = (name: string) => join(import.meta.dirname, 'fixtures', name);
const fixtureUrl = (...parts: string[]) =>
  pathToFileURL(join(import.meta.dirname, 'fixtures', ...parts)).href;

describe('normalizeModuleShape', () => {
  // Pure unit tests for the ESM/CJS-interop normalizer. Vitest's own module
  // transform intercepts dynamic `import()` of both .ts and .cjs files and
  // delivers an ESM-shape namespace, so we can't reliably reproduce tsx's
  // CJS-wrapped shape through a real `await import(url)` inside the test
  // runner. Exercising the normalizer directly with hand-constructed
  // namespaces is the honest unit boundary.

  it('passes through the native-ESM shape unchanged', () => {
    const fn = (x: number) => x * 2;
    const norm = normalizeModuleShape<(x: number) => number>({ default: fn });
    expect(norm.default).toBe(fn);
  });

  it('unwraps the CJS-transpiled default-of-default shape', () => {
    const fn = (x: number) => x * 3;
    // tsx's CJS transpile mode yields exactly this shape on dynamic import.
    const norm = normalizeModuleShape<(x: number) => number>({
      default: { default: fn },
    });
    expect(norm.default).toBe(fn);
  });
});

describe('loadModule', () => {
  it('returns { default: <function> } for a native-ESM .ts file', async () => {
    const mod = await loadModule<(x: number) => number>(
      fixtureUrl('module-shapes', 'esm-default.ts'),
    );
    expect(typeof mod.default).toBe('function');
    expect(mod.default?.(3)).toBe(6);
  });

  it('returns { default: undefined } for a file with no default export', async () => {
    const mod = await loadModule<(x: number) => number>(
      fixtureUrl('module-shapes', 'no-default.ts'),
    );
    expect(mod.default).toBeUndefined();
  });
});

describe('loadExtensions', () => {
  it('loads tier-1 loose .ts files', async () => {
    const registry = new Registry();
    const result = await loadExtensions(registry, { cwd: fixtures('basic') });

    expect(result.errors).toEqual([]);
    expect(result.loaded.length).toBe(2);

    const triggers = registry.listTriggers();
    const pipelines = registry.listPipelines();
    expect(triggers.map((t) => t.name)).toEqual(['timer-fast']);
    expect(pipelines.map((p) => p.name).sort()).toEqual([
      'hello',
      'hello-on-timer',
    ]);
  });

  it('loads tier-2 folders with index.ts', async () => {
    const registry = new Registry();
    const result = await loadExtensions(registry, { cwd: fixtures('folders') });

    expect(result.errors).toEqual([]);
    const triggers = registry.listTriggers();
    expect(triggers.map((t) => t.name)).toEqual(['inside-folder']);
  });

  it('discovers tier-3 folders via package.json manifest', () => {
    // Verify discovery without invoking the loader — tier-3 extensions
    // live in their own package boundary which complicates module
    // resolution in the test fixture. Discovery itself is what the
    // tier is about; loading is the same code path as tier 1/2.
    const kindDir = join(fixtures('manifest'), '.thread-phase', 'pipelines');
    const paths = discoverExtensionPaths(kindDir);
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatch(/with-deps\/index\.ts$/);
  });

  it('isolates per-extension failures and keeps loading', async () => {
    const logs: string[] = [];
    const registry = new Registry();
    const result = await loadExtensions(registry, {
      cwd: fixtures('broken'),
      log: (m) => logs.push(m),
    });

    // 'ok.ts' should load, 'missing-default.ts' should error.
    expect(result.loaded.some((p) => p.endsWith('ok.ts'))).toBe(true);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.path).toMatch(/missing-default\.ts$/);
    expect(logs.join('\n')).toMatch(/missing-default\.ts/);
    expect(registry.listPipelines().map((p) => p.name)).toEqual(['ok']);
  });

  it('strict mode throws on first failure', async () => {
    const registry = new Registry();
    await expect(
      loadExtensions(registry, { cwd: fixtures('broken'), strict: true }),
    ).rejects.toThrow(/no default export/);
  });

  it('returns empty results when .thread-phase/ is absent', async () => {
    const registry = new Registry();
    const result = await loadExtensions(registry, { cwd: '/tmp' });
    expect(result.loaded).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('attributes each registration to its source path', async () => {
    const registry = new Registry();
    await loadExtensions(registry, { cwd: fixtures('basic') });

    const pipelines = registry.listPipelines();
    const hello = pipelines.find((p) => p.name === 'hello');
    expect(hello?.source).toMatch(/pipelines\/hello\.ts$/);
  });

  it('rejects duplicate trigger names with a clear message', async () => {
    const registry = new Registry();
    // First registration succeeds.
    await loadExtensions(registry, { cwd: fixtures('basic') });
    // Re-register the same trigger via direct API.
    registry.currentSource = '/fake/path.ts';
    expect(() =>
      registry.registerTrigger('timer-fast', {
        name: 'dup',
        async *start() {},
        async stop() {},
      }),
    ).toThrow(/duplicate trigger "timer-fast"/);
  });
});
