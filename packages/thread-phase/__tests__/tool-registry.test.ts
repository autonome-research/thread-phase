import { describe, it, expect, vi } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import type { ToolDefinition } from '../src/messages.js';

const addDef: ToolDefinition = {
  name: 'add',
  description: 'add two integers',
  inputSchema: {
    type: 'object',
    properties: { a: { type: 'number' }, b: { type: 'number' } },
    required: ['a', 'b'],
  },
};

describe('ToolRegistry', () => {
  it('routes a valid call to the handler and returns its content', async () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async (args) => String((args.a as number) + (args.b as number)));
    expect(await reg.execute('add', 'id1', { a: 2, b: 3 })).toEqual({
      toolCallId: 'id1',
      content: '5',
    });
  });

  it('rejects duplicate registration loudly', () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async () => '');
    expect(() => reg.register(addDef, async () => '')).toThrow(/already registered/);
  });

  it('returns agent-readable error for unknown tool', async () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async () => 'never');
    const r = await reg.execute('multiply', 'id', {});
    expect(r.toolCallId).toBe('id');
    expect(r.content).toMatch(/unknown tool "multiply"/);
    expect(r.content).toMatch(/add/); // lists registered tools
  });

  it('returns validation error when required arg is missing', async () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async () => 'never');
    const r = await reg.execute('add', 'id', { a: 1 });
    expect(r.content).toMatch(/invalid arguments for "add"/);
    expect(r.content).toMatch(/required property 'b'/);
  });

  it('returns validation error on type mismatch', async () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async () => 'never');
    const r = await reg.execute('add', 'id', { a: 'x', b: 1 });
    expect(r.content).toMatch(/\/a must be number/);
  });

  it('catches handler exceptions and returns them as content', async () => {
    const reg = new ToolRegistry();
    reg.register(addDef, async () => {
      throw new Error('boom');
    });
    const r = await reg.execute('add', 'id', { a: 1, b: 2 });
    expect(r.content).toMatch(/tool "add" threw: boom/);
  });

  it('skips validation when { validate: false }', async () => {
    const handler = vi.fn(async () => 'ok');
    const reg = new ToolRegistry({ validate: false });
    reg.register(addDef, handler);
    // Args that would fail validation pass straight through
    const r = await reg.execute('add', 'id', { a: 'not-a-number' });
    expect(r.content).toBe('ok');
    expect(handler).toHaveBeenCalledWith({ a: 'not-a-number' }, { toolCallId: 'id' });
  });

  it('definitions() returns all registered tools', () => {
    const otherDef: ToolDefinition = { ...addDef, name: 'sub' };
    const reg = new ToolRegistry();
    reg.register(addDef, async () => '');
    reg.register(otherDef, async () => '');
    expect(reg.definitions().map((d) => d.name)).toEqual(['add', 'sub']);
  });

  it('has() reports registration status', () => {
    const reg = new ToolRegistry();
    expect(reg.has('add')).toBe(false);
    reg.register(addDef, async () => '');
    expect(reg.has('add')).toBe(true);
  });
});
