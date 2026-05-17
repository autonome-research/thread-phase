import { describe, it, expect } from 'vitest';
import { injectMemory, injectResume } from '../src/injectors.js';
import type { InferenceAgentConfig, ResumeToken } from 'thread-phase/agents';
import type { AcpAgentConfig } from '../src/acp/index.js';
import type { AnthropicAgentConfig } from '../src/anthropic/index.js';
import type { CodexAgentConfig } from '../src/codex/index.js';
import type { ClaudeCodeAgentConfig } from '../src/claude-code/index.js';
import type { HermesAgentConfig } from '../src/hermes/index.js';
import type { OpenClawAgentConfig } from '../src/openclaw/index.js';

describe('injectMemory', () => {
  it('inference splices memory into config.config.systemPrompt', () => {
    const cfg: InferenceAgentConfig = {
      config: {
        name: 'test',
        systemPrompt: 'Be helpful.',
        model: 'm',
        tools: [],
        maxToolRounds: 1,
        maxTokens: 100,
      },
      messages: [],
      runnerOptions: {} as InferenceAgentConfig['runnerOptions'],
    };
    const out = injectMemory.inference(cfg, 'User likes terse answers.');
    expect(out.config.systemPrompt).toContain('Be helpful.');
    expect(out.config.systemPrompt).toContain('User likes terse answers.');
    // Original untouched.
    expect(cfg.config.systemPrompt).toBe('Be helpful.');
  });

  it('inference passes through unchanged when memory is empty', () => {
    const cfg: InferenceAgentConfig = {
      config: {
        name: 'test',
        systemPrompt: 'Be helpful.',
        model: 'm',
        tools: [],
        maxToolRounds: 1,
        maxTokens: 100,
      },
      messages: [],
      runnerOptions: {} as InferenceAgentConfig['runnerOptions'],
    };
    const out = injectMemory.inference(cfg, '');
    expect(out).toBe(cfg);
  });

  it('anthropic splices into systemPrompt', () => {
    const cfg: AnthropicAgentConfig = {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: 'Respond briefly.',
    };
    const out = injectMemory.anthropic(cfg, 'User: Alice.');
    expect(out.systemPrompt).toContain('Respond briefly.');
    expect(out.systemPrompt).toContain('User: Alice.');
  });

  it('anthropic handles missing systemPrompt', () => {
    const cfg: AnthropicAgentConfig = {
      model: 'claude-test',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = injectMemory.anthropic(cfg, 'memory text');
    expect(out.systemPrompt).toContain('memory text');
  });

  it('codex splices into instructions', () => {
    const cfg: CodexAgentConfig = {
      model: 'gpt-test',
      input: 'hi',
      instructions: 'Be concise.',
    };
    const out = injectMemory.codex(cfg, 'recall here');
    expect(out.instructions).toContain('Be concise.');
    expect(out.instructions).toContain('recall here');
  });

  it('claudeCode prepends memory to prompt', () => {
    const cfg: ClaudeCodeAgentConfig = {
      cwd: '/tmp',
      prompt: 'Do the thing.',
    };
    const out = injectMemory.claudeCode(cfg, 'context');
    expect(out.prompt).toContain('context');
    expect(out.prompt).toContain('Do the thing.');
    // The original prompt comes after the memory.
    expect(out.prompt.indexOf('context')).toBeLessThan(out.prompt.indexOf('Do the thing.'));
  });

  it('acp handles string prompt', () => {
    const cfg: AcpAgentConfig = {
      command: 'noop',
      cwd: '/tmp',
      prompt: 'Hi.',
    };
    const out = injectMemory.acp(cfg, 'memory');
    expect(typeof out.prompt).toBe('string');
    expect(out.prompt).toContain('memory');
    expect(out.prompt).toContain('Hi.');
  });

  it('acp handles ContentBlock[] prompt — injects a leading text block', () => {
    const cfg: AcpAgentConfig = {
      command: 'noop',
      cwd: '/tmp',
      prompt: [{ type: 'text', text: 'block 1' }],
    };
    const out = injectMemory.acp(cfg, 'memory');
    expect(Array.isArray(out.prompt)).toBe(true);
    if (Array.isArray(out.prompt)) {
      expect(out.prompt).toHaveLength(2);
      expect(out.prompt[0]?.type).toBe('text');
      // The first block carries the memory, original blocks come after.
      if (out.prompt[0]?.type === 'text') {
        expect(out.prompt[0].text).toContain('memory');
      }
    }
  });

  it('hermes and openClaw mirror acp behavior', () => {
    const hermes: HermesAgentConfig = { cwd: '/tmp', prompt: 'do X' };
    const openClaw: OpenClawAgentConfig = { cwd: '/tmp', prompt: 'do Y' };
    expect(injectMemory.hermes(hermes, 'mem').prompt).toContain('mem');
    expect(injectMemory.openClaw(openClaw, 'mem').prompt).toContain('mem');
  });
});

describe('injectResume', () => {
  it('inference passes through (no resumption)', () => {
    const cfg: InferenceAgentConfig = {
      config: { name: 't', systemPrompt: '', model: 'm', tools: [], maxToolRounds: 1, maxTokens: 100 },
      messages: [],
      runnerOptions: {} as InferenceAgentConfig['runnerOptions'],
    };
    const token: ResumeToken = { kind: 'opaque', data: 'whatever' };
    expect(injectResume.inference(cfg, token)).toBe(cfg);
  });

  it('anthropic passes through (no resumption)', () => {
    const cfg: AnthropicAgentConfig = { model: 'c', messages: [] };
    const token: ResumeToken = { kind: 'opaque', data: 'whatever' };
    expect(injectResume.anthropic(cfg, token)).toBe(cfg);
  });

  it('codex applies response-id tokens', () => {
    const cfg: CodexAgentConfig = { model: 'gpt-x', input: 'hi' };
    const token: ResumeToken = { kind: 'response-id', id: 'resp_abc', provider: 'openai' };
    const out = injectResume.codex(cfg, token);
    expect(out.previousResponseId).toBe('resp_abc');
  });

  it('codex skips non-response-id tokens', () => {
    const cfg: CodexAgentConfig = { model: 'gpt-x', input: 'hi' };
    const token: ResumeToken = { kind: 'opaque', data: 'something' };
    const out = injectResume.codex(cfg, token);
    expect(out.previousResponseId).toBeUndefined();
  });

  it('claudeCode applies opaque tokens via resumeSessionId', () => {
    const cfg: ClaudeCodeAgentConfig = { cwd: '/tmp', prompt: 'hi' };
    const token: ResumeToken = { kind: 'opaque', data: 'sess_xyz' };
    const out = injectResume.claudeCode(cfg, token);
    expect(out.resumeSessionId).toBe('sess_xyz');
  });

  it('acp applies opaque tokens via resumeSessionId', () => {
    const cfg: AcpAgentConfig = { command: 'noop', cwd: '/tmp', prompt: 'hi' };
    const token: ResumeToken = { kind: 'opaque', data: 'sess_abc' };
    expect(injectResume.acp(cfg, token).resumeSessionId).toBe('sess_abc');
  });

  it('hermes and openClaw apply opaque tokens', () => {
    const h: HermesAgentConfig = { cwd: '/tmp', prompt: 'hi' };
    const o: OpenClawAgentConfig = { cwd: '/tmp', prompt: 'hi' };
    const token: ResumeToken = { kind: 'opaque', data: 's' };
    expect(injectResume.hermes(h, token).resumeSessionId).toBe('s');
    expect(injectResume.openClaw(o, token).resumeSessionId).toBe('s');
  });

  it('hermes ignores non-opaque tokens', () => {
    const h: HermesAgentConfig = { cwd: '/tmp', prompt: 'hi' };
    const token: ResumeToken = { kind: 'response-id', id: 'r', provider: 'openai' };
    expect(injectResume.hermes(h, token).resumeSessionId).toBeUndefined();
  });
});
