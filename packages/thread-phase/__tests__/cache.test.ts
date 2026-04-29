import { describe, it, expect, vi } from 'vitest';
import { PipelineCache } from '../src/cache.js';

describe('PipelineCache', () => {
  it('round-trips set/get with type narrowing via generic', () => {
    const c = new PipelineCache();
    c.set('k', 42);
    expect(c.get<number>('k')).toBe(42);
  });

  it('returns undefined for missing keys', () => {
    expect(new PipelineCache().get('nope')).toBeUndefined();
  });

  it('has() reflects presence', () => {
    const c = new PipelineCache();
    expect(c.has('x')).toBe(false);
    c.set('x', null);
    expect(c.has('x')).toBe(true);
  });

  it('getOrFetch only invokes the fetcher once per key', async () => {
    const c = new PipelineCache();
    const fetcher = vi.fn().mockResolvedValue('value');
    expect(await c.getOrFetch('k', fetcher)).toBe('value');
    expect(await c.getOrFetch('k', fetcher)).toBe('value');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('clear() empties the store', () => {
    const c = new PipelineCache();
    c.set('a', 1);
    c.set('b', 2);
    expect(c.size).toBe(2);
    c.clear();
    expect(c.size).toBe(0);
  });
});

describe('PipelineCache.namespace', () => {
  it('isolates keys between namespaces', () => {
    const root = new PipelineCache();
    const a = root.namespace('a');
    const b = root.namespace('b');
    a.set('k', 1);
    b.set('k', 2);
    expect(a.get('k')).toBe(1);
    expect(b.get('k')).toBe(2);
    expect(root.get('k')).toBeUndefined();
  });

  it('shares the underlying store with the root cache', () => {
    const root = new PipelineCache();
    const ns = root.namespace('foo');
    ns.set('bar', 'value');
    expect(root.get('foo:bar')).toBe('value');
    expect(root.size).toBe(1);
    expect(ns.size).toBe(1);
  });

  it('clear() on a sub-cache only drops keys in that namespace', () => {
    const root = new PipelineCache();
    root.set('global', 'g');
    const a = root.namespace('a');
    const b = root.namespace('b');
    a.set('x', 1);
    b.set('x', 2);
    a.clear();
    expect(a.get('x')).toBeUndefined();
    expect(b.get('x')).toBe(2);
    expect(root.get('global')).toBe('g');
  });

  it('nested namespaces concatenate prefixes', () => {
    const root = new PipelineCache();
    const ns = root.namespace('a').namespace('b');
    ns.set('k', 'v');
    expect(root.get('a:b:k')).toBe('v');
  });

  it('rejects empty namespace names', () => {
    const root = new PipelineCache();
    expect(() => root.namespace('')).toThrow();
  });
});
