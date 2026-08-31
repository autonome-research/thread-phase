import { describe, it, expect } from 'vitest';
import {
  reduceHeadTail,
  reduceFirstNChars,
  reduceSchemaOnly,
  reduceSync,
  reduceAsync,
  isAsyncStrategy,
} from '../src/context/curator/index.js';

describe('reduceHeadTail', () => {
  it('returns content unchanged when shorter than the kept window', () => {
    const content = ['a', 'b', 'c'].join('\n');
    expect(reduceHeadTail(content, { headLines: 10, tailLines: 5 })).toBe(content);
  });

  it('keeps first N and last M lines with elision marker', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const out = reduceHeadTail(lines.join('\n'), { headLines: 5, tailLines: 3 });
    const outLines = out.split('\n');
    expect(outLines[0]).toBe('line 0');
    expect(outLines[4]).toBe('line 4');
    expect(outLines[5]).toMatch(/^\.\.\. \[\d+ lines elided\] \.\.\./);
    expect(outLines.at(-1)).toBe('line 99');
  });

  it('counts the elided lines correctly', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${i}`);
    const out = reduceHeadTail(lines.join('\n'), { headLines: 30, tailLines: 15 });
    expect(out).toContain('[55 lines elided]'); // 100 - 30 - 15
  });

  it('uses defaults when no options provided', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    const out = reduceHeadTail(lines.join('\n'));
    // Default 30 + 15
    expect(out).toContain('[55 lines elided]');
  });
});

describe('reduceFirstNChars', () => {
  it('returns content unchanged when shorter than nChars', () => {
    expect(reduceFirstNChars('short', { nChars: 100 })).toBe('short');
  });

  it('truncates with marker noting characters dropped', () => {
    const content = 'abc'.repeat(2000);
    const out = reduceFirstNChars(content, { nChars: 1000 });
    expect(out.length).toBeLessThan(content.length);
    expect(out).toMatch(/\[\d+ chars truncated\]/);
  });

  it('prefers a newline boundary near the cutoff', () => {
    const content = `${'x'.repeat(900)}\n${'y'.repeat(2000)}`;
    const out = reduceFirstNChars(content, { nChars: 950 });
    // The newline at idx 900 is within the 50% threshold (450..950) so
    // cutoff should land just after it; the y's should be gone.
    expect(out).not.toContain('y');
  });

  it('closes open code fences by dropping the dangling opener', () => {
    const content = `${'x'.repeat(800)}\n\`\`\`typescript\n${'y'.repeat(2000)}`;
    const out = reduceFirstNChars(content, { nChars: 1000 });
    const fenceCount = (out.match(/```/g) ?? []).length;
    expect(fenceCount % 2).toBe(0);
  });
});

describe('reduceSchemaOnly', () => {
  it('preserves structure of a small JSON object', () => {
    const json = JSON.stringify({ name: 'Alice', age: 30 });
    const out = reduceSchemaOnly(json);
    const parsed = JSON.parse(out.replace(/\n\[schema_only reduction\]$/, ''));
    expect(parsed).toEqual({ name: 'Alice', age: 30 });
  });

  it('keeps first item of long arrays and notes the rest', () => {
    const json = JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => ({ id: i })) });
    const out = reduceSchemaOnly(json);
    expect(out).toContain('"<49 more items>"');
    expect(out).toContain('"id": 0');
  });

  it('truncates strings over 80 chars', () => {
    const json = JSON.stringify({ note: 'x'.repeat(200) });
    const out = reduceSchemaOnly(json);
    const parsed = JSON.parse(out.replace(/\n\[schema_only reduction\]$/, ''));
    expect((parsed.note as string).endsWith('...')).toBe(true);
    expect((parsed.note as string).length).toBeLessThan(100);
  });

  it('falls back to head_tail on non-JSON', () => {
    const content = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const out = reduceSchemaOnly(content);
    // head_tail signature is the elision marker, not the schema marker
    expect(out).toMatch(/\[\d+ lines elided\]/);
    expect(out).not.toContain('[schema_only reduction]');
  });

  it('handles JSON embedded in prose by parsing from first { or [', () => {
    const content = 'Tool output:\n' + JSON.stringify({ status: 'ok', items: [1, 2, 3] });
    const out = reduceSchemaOnly(content);
    expect(out).toContain('Tool output:');
    expect(out).toContain('"status"');
  });
});

describe('strategy dispatch', () => {
  it('reduceSync routes to the right strategy by name', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${i}`).join('\n');
    expect(reduceSync('head_tail', lines)).toContain('[55 lines elided]');
    expect(reduceSync('first_n_chars', 'a'.repeat(3000))).toMatch(/chars truncated/);
    expect(reduceSync('schema_only', '{"k":"v"}')).toContain('[schema_only reduction]');
  });

  it('reduceSync returns undefined for unknown or async strategy names', () => {
    expect(reduceSync('bogus', 'x')).toBeUndefined();
    expect(reduceSync('summarize', 'x')).toBeUndefined();
  });

  it('reduceAsync falls back to head_tail when no client is provided', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => `${i}`).join('\n');
    const out = await reduceAsync('summarize', lines);
    expect(out).toMatch(/\[\d+ lines elided\]/);
  });

  it('reduceAsync returns undefined for unknown or sync strategy names', async () => {
    expect(await reduceAsync('bogus', 'x')).toBeUndefined();
    expect(await reduceAsync('head_tail', 'x')).toBeUndefined();
  });

  it('isAsyncStrategy identifies summarize as async', () => {
    expect(isAsyncStrategy('summarize')).toBe(true);
    expect(isAsyncStrategy('head_tail')).toBe(false);
    expect(isAsyncStrategy('first_n_chars')).toBe(false);
    expect(isAsyncStrategy('schema_only')).toBe(false);
    expect(isAsyncStrategy('bogus')).toBe(false);
  });
});
