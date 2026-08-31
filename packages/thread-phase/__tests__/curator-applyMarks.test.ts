import { describe, it, expect } from 'vitest';
import {
  applyCuratorMarks,
  applyCuratorMarksWithStats,
  MARKED_DROP,
  REDUCED,
} from '../src/context/curator/index.js';
import type { Message } from '../src/messages.js';

type Tagged = Message & { msgId: string };

function sys(content: string, msgId: string): Tagged {
  return { role: 'system', content, msgId };
}
function user(content: string, msgId: string): Tagged {
  return { role: 'user', content, msgId };
}
function asst(content: string, msgId: string): Tagged {
  return { role: 'assistant', content, toolCalls: [], msgId };
}
function tool(content: string, toolCallId: string, msgId: string): Tagged {
  return { role: 'tool', content, toolCallId, msgId };
}

describe('applyCuratorMarks', () => {
  it('returns a copy unchanged when there are no marks', () => {
    const msgs: Tagged[] = [sys('s', 'm1'), user('u', 'm2')];
    const out = applyCuratorMarks(msgs, new Map(), new Map());
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(msgs[0]); // same reference — no copy needed
    expect(out).not.toBe(msgs); // but the array is a new reference
  });

  it('drops messages tagged marked_drop', () => {
    const msgs: Tagged[] = [
      sys('keep me', 'm1'),
      user('drop me', 'm2'),
      asst('keep me too', 'm3'),
    ];
    const tags = new Map([['m2', new Set([MARKED_DROP])]]);
    const out = applyCuratorMarks(msgs, tags, new Map());
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.msgId)).toEqual(['m1', 'm3']);
  });

  it('swaps content for messages tagged reduced with available content', () => {
    const msgs: Tagged[] = [tool('full long content', 'call_a', 'm1')];
    const tags = new Map([['m1', new Set([REDUCED])]]);
    const reduced = new Map([['m1', 'short']]);
    const out = applyCuratorMarks(msgs, tags, reduced);
    expect(out).toHaveLength(1);
    expect(out[0]!.content).toBe('short');
    // toolCallId and role preserved
    if (out[0]!.role === 'tool') {
      expect(out[0]!.toolCallId).toBe('call_a');
    } else {
      throw new Error('expected role=tool');
    }
  });

  it('passes message through unchanged when reduced tag has no content', () => {
    const msgs: Tagged[] = [tool('original', 'call_a', 'm1')];
    const tags = new Map([['m1', new Set([REDUCED])]]);
    const out = applyCuratorMarks(msgs, tags, new Map());
    expect(out[0]!.content).toBe('original');
  });

  it('drops take precedence over reductions', () => {
    const msgs: Tagged[] = [user('x', 'm1')];
    const tags = new Map([['m1', new Set([MARKED_DROP, REDUCED])]]);
    const reduced = new Map([['m1', 'should not show']]);
    const out = applyCuratorMarks(msgs, tags, reduced);
    expect(out).toHaveLength(0);
  });

  it('skips messages without an id (no marks possible)', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'no id here' },
      { role: 'assistant', content: 'still no id', toolCalls: [] },
    ];
    const out = applyCuratorMarks(msgs, new Map(), new Map());
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(msgs[0]);
  });

  it('honors enabled=false as a no-op pass-through', () => {
    const msgs: Tagged[] = [user('drop me', 'm1')];
    const tags = new Map([['m1', new Set([MARKED_DROP])]]);
    const out = applyCuratorMarks(msgs, tags, new Map(), { enabled: false });
    expect(out).toHaveLength(1);
  });

  it('does not mutate input array or messages', () => {
    const msgs: Tagged[] = [tool('original', 'c', 'm1')];
    const tags = new Map([['m1', new Set([REDUCED])]]);
    const reduced = new Map([['m1', 'changed']]);
    const before = JSON.stringify(msgs);
    applyCuratorMarks(msgs, tags, reduced);
    expect(JSON.stringify(msgs)).toBe(before);
  });

  it('accepts a custom id resolver', () => {
    type Indexed = { role: 'user'; content: string };
    const msgs: Indexed[] = [
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ];
    const tags = new Map([['idx-1', new Set([MARKED_DROP])]]);
    const out = applyCuratorMarks(msgs, tags, new Map(), {
      getMessageId: (_m, i) => `idx-${i}`,
    });
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.content)).toEqual(['a', 'c']);
  });

  it('preserves message order through mixed drops + reductions', () => {
    const msgs: Tagged[] = [
      user('u1', 'm1'),
      asst('a1', 'm2'),
      tool('long', 'c', 'm3'),
      asst('a2', 'm4'),
    ];
    const tags = new Map([
      ['m2', new Set([MARKED_DROP])],
      ['m3', new Set([REDUCED])],
    ]);
    const reduced = new Map([['m3', 'short']]);
    const out = applyCuratorMarks(msgs, tags, reduced);
    expect(out.map((m) => m.msgId)).toEqual(['m1', 'm3', 'm4']);
    expect(out[1]!.content).toBe('short');
  });
});

describe('applyCuratorMarksWithStats', () => {
  it('reports zero counts when nothing applied', () => {
    const msgs: Tagged[] = [sys('s', 'm1')];
    const result = applyCuratorMarksWithStats(msgs, new Map(), new Map());
    expect(result.dropped).toBe(0);
    expect(result.reduced).toBe(0);
    expect(result.messages).toHaveLength(1);
  });

  it('reports counts that match the actual mutation', () => {
    const msgs: Tagged[] = [
      user('keep', 'm1'),
      user('drop1', 'm2'),
      tool('long', 'c1', 'm3'),
      user('drop2', 'm4'),
      tool('long2', 'c2', 'm5'),
    ];
    const tags = new Map([
      ['m2', new Set([MARKED_DROP])],
      ['m3', new Set([REDUCED])],
      ['m4', new Set([MARKED_DROP])],
      ['m5', new Set([REDUCED])],
    ]);
    const reduced = new Map([
      ['m3', 'short3'],
      ['m5', 'short5'],
    ]);
    const result = applyCuratorMarksWithStats(msgs, tags, reduced);
    expect(result.dropped).toBe(2);
    expect(result.reduced).toBe(2);
    expect(result.messages).toHaveLength(3);
  });
});
