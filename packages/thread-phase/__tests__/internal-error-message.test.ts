import { describe, it, expect } from 'vitest';
import {
  toErrorMessage,
  signalReasonToString,
} from '../src/internal/error-message.js';

describe('toErrorMessage', () => {
  it('returns Error.message for Error instances', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('passes strings through unchanged', () => {
    expect(toErrorMessage('just a string')).toBe('just a string');
  });

  it('extracts .message when the value is an object with a string message', () => {
    expect(toErrorMessage({ message: 'sdk-error' })).toBe('sdk-error');
  });

  it('falls back to safeStringify for non-Error, non-string, non-object-with-message values', () => {
    expect(toErrorMessage(42)).toBe('42');
    expect(toErrorMessage(null)).toBe('null');
    expect(toErrorMessage(undefined)).toBe('undefined');
  });

  it('does not throw on objects with non-string .message fields', () => {
    expect(toErrorMessage({ message: 42 })).toBe('[object Object]');
  });
});

describe('signalReasonToString', () => {
  it('returns the string when reason is a string', () => {
    const c = new AbortController();
    c.abort('user-cancel');
    expect(signalReasonToString(c.signal)).toBe('user-cancel');
  });

  it('returns Error.message when reason is an Error (the prior `as string` cast destroyed this)', () => {
    const c = new AbortController();
    c.abort(new Error('upstream-died'));
    expect(signalReasonToString(c.signal)).toBe('upstream-died');
  });

  it('extracts .message when reason is an arbitrary SDK-shaped object', () => {
    const c = new AbortController();
    c.abort({ message: 'fetch-aborted', code: 20 });
    expect(signalReasonToString(c.signal)).toBe('fetch-aborted');
  });

  it('surfaces the spec-default DOMException message when abort() is called with no argument', () => {
    // Per WHATWG, AbortController.abort() with no argument populates
    // signal.reason with a DOMException whose message is the user-agent
    // default ("This operation was aborted" in Node). The prior cast
    // would render this as [object DOMException] via toString(); the
    // helper extracts the .message cleanly.
    const c = new AbortController();
    c.abort();
    expect(signalReasonToString(c.signal)).toMatch(/aborted/i);
  });

  it('uses the caller-provided fallback only when reason is actually undefined', () => {
    // Synthetic fake signal whose reason is explicitly undefined. Real
    // AbortControllers don't produce this shape after .abort(), but
    // composed/proxied signals and pre-abort observers can.
    const fakeSignal = { aborted: true, reason: undefined } as AbortSignal;
    expect(signalReasonToString(fakeSignal)).toBe('aborted');
    expect(signalReasonToString(fakeSignal, 'job-cancelled')).toBe('job-cancelled');
  });
});
