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
