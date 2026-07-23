import { describe, expect, it } from 'vitest';
import { serializeError } from '../src/agents/serialize-error.js';

describe('serializeError hostile-value safety', () => {
  it('never throws for a Proxy that rejects reflection and coercion', () => {
    const hostile = new Proxy(Object.create(null), {
      get() { throw new Error('getter failed'); },
      getPrototypeOf() { throw new Error('prototype failed'); },
    });

    expect(() => serializeError(hostile)).not.toThrow();
    expect(serializeError(hostile)).toEqual({
      name: 'NonError',
      message: '<unserializable>',
    });
  });

  it('retains cycle detection for ordinary Error cause chains', () => {
    const error = new Error('cycle') as Error & { cause?: unknown };
    error.cause = error;
    expect(serializeError(error).cause).toMatchObject({
      name: 'CycleDetected',
      message: expect.stringContaining('cycle'),
    });
  });
});
