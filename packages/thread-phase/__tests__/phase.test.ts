import { describe, it, expect } from 'vitest';
import { requireCtx } from '../src/phase.js';
import { PipelineCache } from '../src/cache.js';

describe('requireCtx', () => {
  const baseCtx = () => ({ cache: new PipelineCache() });

  it('returns the value when set', () => {
    const ctx = { ...baseCtx(), foo: 'hello' as string | undefined };
    expect(requireCtx(ctx, 'foo', 'test-phase')).toBe('hello');
  });

  it('throws with phase name + key when undefined', () => {
    const ctx = { ...baseCtx(), foo: undefined as string | undefined };
    expect(() => requireCtx(ctx, 'foo', 'my-phase')).toThrowError(
      /\[my-phase\] precondition failed: ctx\.foo is not set/,
    );
  });

  it('throws when null', () => {
    const ctx = { ...baseCtx(), foo: null as string | null };
    expect(() => requireCtx(ctx, 'foo', 'p2')).toThrow(/precondition failed/);
  });

  it('does NOT throw on falsy-but-defined values (0, "", false)', () => {
    const ctx = {
      ...baseCtx(),
      zero: 0 as number | undefined,
      empty: '' as string | undefined,
      flag: false as boolean | undefined,
    };
    expect(requireCtx(ctx, 'zero', 'p')).toBe(0);
    expect(requireCtx(ctx, 'empty', 'p')).toBe('');
    expect(requireCtx(ctx, 'flag', 'p')).toBe(false);
  });
});
