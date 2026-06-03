import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseJSON, parseJSONStrict } from '../src/agent-runner.js';

describe('parseJSON', () => {
  // parseJSON warns to console when no onError is provided. Suppress for the
  // intentional-failure cases below so test output stays clean.
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('parses raw JSON', () => {
    expect(parseJSON('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  it('strips ```json fences', () => {
    expect(parseJSON('```json\n{"a":2}\n```', { a: 0 })).toEqual({ a: 2 });
  });

  it('strips bare ``` fences', () => {
    expect(parseJSON('```\n{"a":3}\n```', { a: 0 })).toEqual({ a: 3 });
  });

  it('extracts JSON object from surrounding prose', () => {
    expect(parseJSON('Sure, here you go: {"a":4} — done.', { a: 0 })).toEqual({ a: 4 });
  });

  it('returns the fallback when nothing parses', () => {
    expect(parseJSON('definitely not json at all', { ok: false })).toEqual({ ok: false });
  });

  it('returns the fallback for empty input', () => {
    expect(parseJSON('', { x: null })).toEqual({ x: null });
  });

  it('invokes onError callback (suppresses console warning)', () => {
    const onError = vi.fn();
    parseJSON('garbage', { x: 1 }, onError);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toMatch(/garbage/);
    expect(onError.mock.calls[0]![1]).toBeInstanceOf(Error);
  });
});

describe('parseJSONStrict', () => {
  it('returns the parsed value on success', () => {
    expect(parseJSONStrict<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('shares the extraction logic with parseJSON (fences and braced extraction work)', () => {
    expect(parseJSONStrict('```json\n{"x":2}\n```')).toEqual({ x: 2 });
    expect(parseJSONStrict('lead-in {"y":3} trailing')).toEqual({ y: 3 });
  });

  it('throws SyntaxError on malformed JSON instead of returning a fallback', () => {
    expect(() => parseJSONStrict('not json')).toThrow(SyntaxError);
  });

  it('throws RangeError on adversarial nesting depth (same guard as parseJSON)', () => {
    const adversarial = '{"a":'.repeat(2000) + '1' + '}'.repeat(2000);
    expect(() => parseJSONStrict(adversarial)).toThrow(RangeError);
  });
});
