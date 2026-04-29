/**
 * sanitizeToolPairs is correctness-critical: orphaned tool calls / results
 * cause the inference endpoint to 400 on the next request. Cover the cases
 * where compression has dropped one side of the pair and we need to either
 * stub it in or strip it out.
 */

import { describe, it, expect } from 'vitest';
import { sanitizeToolPairs } from '../src/context/compressor.js';
import type { Message } from '../src/messages.js';

const sys = (content: string): Message => ({ role: 'system', content });
const user = (content: string): Message => ({ role: 'user', content });
const assistant = (
  content: string,
  toolCalls: Array<{ id: string; name: string; input?: Record<string, unknown> }> = [],
): Message => ({
  role: 'assistant',
  content,
  toolCalls: toolCalls.map((tc) => ({ id: tc.id, name: tc.name, input: tc.input ?? {} })),
});
const toolResult = (toolCallId: string, content: string): Message => ({
  role: 'tool',
  toolCallId,
  content,
});

describe('sanitizeToolPairs', () => {
  it('returns input unchanged when every call has a matching result', () => {
    const msgs: Message[] = [
      sys('s'),
      user('u'),
      assistant('thinking', [{ id: 'a', name: 'foo' }]),
      toolResult('a', 'r'),
    ];
    expect(sanitizeToolPairs(msgs)).toEqual(msgs);
  });

  it('drops orphaned tool-result messages (call missing)', () => {
    const msgs: Message[] = [
      sys('s'),
      user('u'),
      toolResult('ghost', 'orphaned'), // no assistant ever called this id
    ];
    expect(sanitizeToolPairs(msgs)).toEqual([sys('s'), user('u')]);
  });

  it('inserts stub results immediately after assistant for orphaned calls', () => {
    const msgs: Message[] = [
      sys('s'),
      user('u'),
      assistant('I will call', [{ id: 'a', name: 'foo' }]),
      // no tool result for "a"
      assistant('next turn', []), // not a tool message, so stubs must be inserted before
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(5);
    expect(out[3]).toEqual({
      role: 'tool',
      toolCallId: 'a',
      content: '[Result removed during context compression]',
    });
    // The follow-on assistant message stays in place.
    expect(out[4]).toEqual(msgs[3]);
  });

  it('does NOT insert stubs when a tool message immediately follows', () => {
    const msgs: Message[] = [
      sys('s'),
      assistant('call', [{ id: 'a', name: 'foo' }]),
      toolResult('a', 'real result'),
    ];
    expect(sanitizeToolPairs(msgs)).toEqual(msgs); // no spurious stubs
  });

  it('appends stubs after real tool results when an assistant has partial orphans', () => {
    // Regression test for the partial-orphan edge case: an assistant emits
    // calls 'a' and 'b'; only 'a' has a real result. The fix preserves the
    // real result and appends a stub for 'b' so the OpenAI invariant
    // "every tool_call.id has a matching tool message" still holds.
    const msgs: Message[] = [
      sys('s'),
      assistant('two calls', [
        { id: 'a', name: 'foo' },
        { id: 'b', name: 'bar' },
      ]),
      toolResult('a', 'ok'),
      assistant('next', []),
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual(sys('s'));
    expect(out[1]).toEqual(msgs[1]); // assistant unchanged
    expect(out[2]).toEqual(toolResult('a', 'ok')); // real result preserved
    expect(out[3]).toEqual({
      role: 'tool',
      toolCallId: 'b',
      content: '[Result removed during context compression]',
    });
    expect(out[4]).toEqual(assistant('next', [])); // follow-on assistant intact
  });

  it('preserves order of real results and appends stubs in tool-call order', () => {
    const msgs: Message[] = [
      sys('s'),
      assistant('three calls', [
        { id: 'a', name: 'foo' },
        { id: 'b', name: 'bar' },
        { id: 'c', name: 'baz' },
      ]),
      toolResult('b', 'real-b'),
      toolResult('c', 'real-c'),
      assistant('next', []),
    ];
    const out = sanitizeToolPairs(msgs);
    expect(out.map((m) => (m.role === 'tool' ? `t:${m.toolCallId}` : m.role))).toEqual([
      'system',
      'assistant',
      't:b',
      't:c',
      't:a',
      'assistant',
    ]);
  });

  it('strips multiple orphaned results in one pass', () => {
    const msgs: Message[] = [
      sys('s'),
      toolResult('x', 'r1'),
      user('u'),
      toolResult('y', 'r2'),
    ];
    expect(sanitizeToolPairs(msgs)).toEqual([sys('s'), user('u')]);
  });
});
