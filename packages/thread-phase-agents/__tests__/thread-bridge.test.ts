import { describe, it, expect } from 'vitest';
import { appendEvent, createThread } from 'thread-phase/agents';
import {
  threadToAcpPrompt,
  threadToAnthropicMessages,
  threadToClaudeCodePrompt,
  threadToCodexInput,
  threadToTranscript,
} from '../src/thread-bridge.js';

function richThread() {
  const t = createThread();
  appendEvent(t, { type: 'agent_start', source: 'claude-code' });
  appendEvent(t, { type: 'text', source: 'claude-code', delta: 'Reviewing src/foo.ts' });
  appendEvent(t, {
    type: 'tool_call',
    source: 'claude-code',
    id: 't1',
    name: 'read_file',
    input: { path: 'src/foo.ts' },
  });
  appendEvent(t, {
    type: 'tool_result',
    source: 'claude-code',
    id: 't1',
    name: 'read_file',
    output: 'export function foo() {}',
    isError: false,
  });
  appendEvent(t, {
    type: 'turn_end',
    source: 'claude-code',
    assistantText: 'Reviewing src/foo.ts',
    toolCallCount: 1,
  });
  appendEvent(t, {
    type: 'agent_end',
    source: 'claude-code',
    reason: 'stop',
  });
  return t;
}

describe('threadToTranscript', () => {
  it('renders text, tool_call, and tool_result events', () => {
    const transcript = threadToTranscript(richThread());
    expect(transcript).toContain('[claude-code] Reviewing src/foo.ts');
    expect(transcript).toContain('[claude-code:tool_call read_file]');
    expect(transcript).toContain('{"path":"src/foo.ts"}');
    expect(transcript).toContain('[claude-code:tool_result read_file] export function foo() {}');
  });

  it('skips lifecycle, error, native, thinking events', () => {
    const t = createThread();
    appendEvent(t, { type: 'agent_start', source: 'x' });
    appendEvent(t, { type: 'thinking', source: 'x', delta: 'pondering' });
    appendEvent(t, {
      type: 'native',
      source: 'x',
      kind: 'something',
      payload: { hidden: true },
    });
    appendEvent(t, {
      type: 'error',
      source: 'x',
      error: { name: 'E', message: 'boom' },
      transient: false,
    });
    appendEvent(t, { type: 'agent_end', source: 'x', reason: 'stop' });
    const transcript = threadToTranscript(t);
    expect(transcript).toBe('');
  });

  it('emits turn_end.assistantText when no text deltas streamed (turns-only adapter)', () => {
    const t = createThread();
    appendEvent(t, {
      type: 'turn_end',
      source: 'turns-only',
      assistantText: 'final answer',
      toolCallCount: 0,
    });
    const transcript = threadToTranscript(t);
    expect(transcript).toContain('[turns-only] final answer');
  });

  it('tags tool errors distinctly from successful results', () => {
    const t = createThread();
    appendEvent(t, {
      type: 'tool_result',
      source: 'x',
      id: 't1',
      name: 'broken',
      output: 'permission denied',
      isError: true,
    });
    const transcript = threadToTranscript(t);
    expect(transcript).toContain('[x:tool_error broken] permission denied');
  });
});

describe('per-adapter renderers', () => {
  it('threadToAcpPrompt returns a single text ContentBlock', () => {
    const blocks = threadToAcpPrompt(richThread());
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe('text');
    if (blocks[0]?.type === 'text') {
      expect(blocks[0].text).toContain('Reviewing src/foo.ts');
    }
  });

  it('threadToClaudeCodePrompt returns the transcript as a string', () => {
    const prompt = threadToClaudeCodePrompt(richThread());
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Reviewing src/foo.ts');
    expect(prompt).toContain('tool_call read_file');
  });

  it('threadToCodexInput returns the transcript as a string (Responses API)', () => {
    const input = threadToCodexInput(richThread());
    expect(typeof input).toBe('string');
    expect(input).toContain('Reviewing src/foo.ts');
  });

  it('threadToAnthropicMessages returns a single user-role message', () => {
    const messages = threadToAnthropicMessages(richThread());
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
    expect(messages[0]?.content).toContain('Reviewing src/foo.ts');
  });

  it('empty thread produces empty/minimal output for each renderer', () => {
    const empty = createThread();
    expect(threadToTranscript(empty)).toBe('');
    expect(threadToClaudeCodePrompt(empty)).toBe('');
    expect(threadToCodexInput(empty)).toBe('');
    const blocks = threadToAcpPrompt(empty);
    expect(blocks[0]?.type).toBe('text');
    if (blocks[0]?.type === 'text') expect(blocks[0].text).toBe('');
    expect(threadToAnthropicMessages(empty)[0]?.content).toBe('');
  });
});
