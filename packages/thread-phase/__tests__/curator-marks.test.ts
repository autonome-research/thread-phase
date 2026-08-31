import { describe, it, expect } from 'vitest';
import {
  MARKED_DROP,
  REDUCED,
  MARKED_REDUCE_PREFIX,
  countPendingMarks,
} from '../src/context/curator/marks.js';

describe('curator/marks constants', () => {
  it('exposes stable string literals callers can compose with', () => {
    expect(MARKED_DROP).toBe('marked_drop');
    expect(REDUCED).toBe('reduced');
    expect(MARKED_REDUCE_PREFIX).toBe('marked_reduce_');
  });
});

describe('countPendingMarks', () => {
  it('returns zeros for an empty map', () => {
    expect(countPendingMarks(new Map())).toEqual({
      markedDrop: 0,
      markedReduce: 0,
      reduced: 0,
    });
  });

  it('counts each category independently', () => {
    const tags = new Map<string, Set<string>>([
      ['m1', new Set([MARKED_DROP])],
      ['m2', new Set(['marked_reduce_summarize'])],
      ['m3', new Set(['marked_reduce_head_tail', REDUCED])],
      ['m4', new Set(['user_directive'])],
      ['m5', new Set([REDUCED])],
    ]);
    const counts = countPendingMarks(tags);
    expect(counts.markedDrop).toBe(1);
    expect(counts.markedReduce).toBe(2); // m2 + m3
    expect(counts.reduced).toBe(2); // m3 + m5
  });

  it('counts a message with multiple marked_reduce_* tags only once', () => {
    const tags = new Map<string, Set<string>>([
      ['m1', new Set(['marked_reduce_summarize', 'marked_reduce_head_tail'])],
    ]);
    expect(countPendingMarks(tags).markedReduce).toBe(1);
  });

  it('ignores unrelated tags', () => {
    const tags = new Map<string, Set<string>>([
      ['m1', new Set(['user_directive', 'assistant_reasoning'])],
    ]);
    expect(countPendingMarks(tags)).toEqual({
      markedDrop: 0,
      markedReduce: 0,
      reduced: 0,
    });
  });
});
