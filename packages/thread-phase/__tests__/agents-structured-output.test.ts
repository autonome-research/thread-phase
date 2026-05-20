/**
 * Tests for the prompted structured-output helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  applyStructuredOutputPrompt,
  extractResponseBlock,
  parseStructured,
  parseStructuredFromText,
  StructuredOutputParseError,
  type StructuredOutputConfig,
} from '../src/agents/structured-output.js';
import type { AgentRunResult } from '../src/agents/protocol.js';

describe('extractResponseBlock', () => {
  it('returns inner text for a clean block', () => {
    const text = 'thinking out loud...\n<response>{"a":1}</response>';
    expect(extractResponseBlock(text)).toBe('{"a":1}');
  });

  it('returns null when no block is present', () => {
    expect(extractResponseBlock('no markers here')).toBeNull();
  });

  it('returns the LAST block when multiple are present', () => {
    const text = '<response>{"first":true}</response>\nactually wait\n<response>{"second":true}</response>';
    expect(extractResponseBlock(text)).toBe('{"second":true}');
  });

  it('trims surrounding whitespace inside the block', () => {
    const text = '<response>\n  {"a":1}\n</response>';
    expect(extractResponseBlock(text)).toBe('{"a":1}');
  });

  it('handles multi-line JSON content inside the block', () => {
    const text = '<response>{\n  "a": 1,\n  "b": 2\n}</response>';
    const inner = extractResponseBlock(text);
    expect(inner).toBeTruthy();
    expect(JSON.parse(inner!)).toEqual({ a: 1, b: 2 });
  });
});

describe('parseStructuredFromText', () => {
  const spec: StructuredOutputConfig = {
    schema: { type: 'object', properties: { x: { type: 'number' } } },
  };

  it('parses valid JSON from a clean block', () => {
    const out = parseStructuredFromText(
      'prelude <response>{"x": 42}</response>',
      spec,
    );
    expect(out).toEqual({ x: 42 });
  });

  it('throws StructuredOutputParseError when no block is present', () => {
    expect(() => parseStructuredFromText('plain text only', spec))
      .toThrow(StructuredOutputParseError);
  });

  it('throws StructuredOutputParseError when JSON is invalid', () => {
    let caught: unknown;
    try {
      parseStructuredFromText('<response>{not json}</response>', spec);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredOutputParseError);
    expect((caught as StructuredOutputParseError).message).toMatch(/invalid JSON/);
    expect((caught as StructuredOutputParseError).window).toBe('{not json}');
  });

  it('throws StructuredOutputParseError when validator rejects the payload', () => {
    const reject: StructuredOutputConfig = {
      schema: 'must have x',
      validate: (d) => typeof d === 'object' && d !== null && 'x' in d,
    };
    expect(() =>
      parseStructuredFromText('<response>{"y":1}</response>', reject),
    ).toThrow(StructuredOutputParseError);
  });

  it('returns the payload when validator accepts it', () => {
    const accept: StructuredOutputConfig = {
      schema: 'must have x',
      validate: (d) => typeof d === 'object' && d !== null && 'x' in d,
    };
    const out = parseStructuredFromText('<response>{"x":1}</response>', accept);
    expect(out).toEqual({ x: 1 });
  });

  it('attaches the offending text window on missing-block errors', () => {
    let caught: unknown;
    try {
      parseStructuredFromText('a'.repeat(1000), spec);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(StructuredOutputParseError);
    expect((caught as StructuredOutputParseError).window.length).toBeLessThanOrEqual(500);
  });
});

describe('parseStructured', () => {
  it('reads from result.text', () => {
    const result: AgentRunResult = {
      text: '<response>{"hello":"world"}</response>',
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      executedToolCalls: [],
    };
    expect(parseStructured(result, { schema: '{}' })).toEqual({ hello: 'world' });
  });
});

describe('applyStructuredOutputPrompt', () => {
  it('appends the instruction with a blank-line separator', () => {
    const prompt = applyStructuredOutputPrompt('You are a helper.', { schema: '{}' });
    expect(prompt.startsWith('You are a helper.\n\n')).toBe(true);
    expect(prompt).toMatch(/<response>/);
  });

  it('embeds string schemas verbatim', () => {
    const prompt = applyStructuredOutputPrompt('sys', { schema: 'one of: yes|no' });
    expect(prompt).toContain('one of: yes|no');
  });

  it('JSON-stringifies object schemas with 2-space indent', () => {
    const schema = { type: 'object', properties: { foo: { type: 'string' } } };
    const prompt = applyStructuredOutputPrompt('sys', { schema });
    const expected = JSON.stringify(schema, null, 2);
    expect(prompt).toContain(expected);
  });

  it('returns just the instruction when the base prompt is empty', () => {
    const prompt = applyStructuredOutputPrompt('', { schema: '{}' });
    expect(prompt.startsWith('When finished')).toBe(true);
  });

  it('mentions the response tag and the no-trailing-text constraint', () => {
    const prompt = applyStructuredOutputPrompt('sys', { schema: '{}' });
    expect(prompt).toMatch(/<response>\.\.\.<\/response>/);
    expect(prompt).toMatch(/Do not include any text after the closing tag/);
  });
});
