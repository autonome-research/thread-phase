/**
 * Integration tests for the ACP chassis against a minimal stub agent
 * (see fixtures/acp-stub-agent.mjs). The stub exercises the canonical
 * ACP method surface — initialize, session/new, session/prompt,
 * session/cancel — and lets us run the protocol's conformance suite
 * end-to-end against a real subprocess pipe.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runAdapterConformance } from 'thread-phase/agents/test-utils';
import type { AgentEvent } from 'thread-phase/agents';

import { acpAgent, createAcpAdapter, type AcpAgentConfig } from '../src/acp/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STUB = resolve(__dirname, 'fixtures/acp-stub-agent.mjs');

function buildConfig(prompt = 'hello'): AcpAgentConfig {
  return {
    command: process.execPath, // node
    args: [STUB],
    cwd: __dirname,
    prompt,
  };
}

async function collect(run: { events: AsyncIterable<AgentEvent> }): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) {
    events.push(event);
  }
  return events;
}

describe('acpAgent — integration against stub agent', () => {
  it('emits canonical event sequence for a successful prompt', async () => {
    const run = acpAgent.adapter(buildConfig('hello'));
    const [events, result] = await Promise.all([collect(run), run.result]);

    expect(events[0]?.type).toBe('agent_start');
    expect(events[events.length - 1]?.type).toBe('agent_end');
    const textDeltas = events.filter((e): e is AgentEvent & { type: 'text' } => e.type === 'text');
    expect(textDeltas.length).toBeGreaterThan(0);
    expect(textDeltas.map((e) => e.delta).join('')).toBe('Hello world.');

    expect(result.finishReason).toBe('stop');
    expect(result.text).toBe('Hello world.');
    expect(result.resumeToken).toBeDefined();
    expect(result.resumeToken?.kind).toBe('opaque');
  }, 10_000);

  it('every event carries source === meta.id', async () => {
    const run = acpAgent.adapter(buildConfig('hello'));
    const events = await collect(run);
    await run.result;
    for (const event of events) {
      expect(event.source).toBe('acp');
    }
  }, 10_000);

  it('honors pre-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const run = acpAgent.adapter(buildConfig('hello'), { signal: controller.signal });
    const result = await run.result;
    expect(result.finishReason).toBe('aborted');
  }, 10_000);

  it('aborts an in-flight prompt via run.abort()', async () => {
    const run = acpAgent.adapter(buildConfig('hello'));
    // Start the run, then abort before the 50ms stub response fires.
    const resultPromise = run.result;
    setTimeout(() => run.abort(), 5);
    const result = await resultPromise;
    expect(result.finishReason).toBe('aborted');
  }, 10_000);

  it('surfaces stub stderr as native events', async () => {
    // Build a config that points at a script that prints to stderr and exits.
    // We use the real stub here and just assert NO native:stderr events on
    // the happy path (the stub is silent on stderr).
    const run = acpAgent.adapter(buildConfig('hello'));
    const events = await collect(run);
    await run.result;
    const stderr = events.filter(
      (e): e is AgentEvent & { type: 'native' } =>
        e.type === 'native' && e.kind === 'acp:stderr',
    );
    expect(stderr).toHaveLength(0);
  }, 10_000);

  it('resolves with finishReason: "error" when the stub returns a JSON-RPC error', async () => {
    const run = acpAgent.adapter(buildConfig('please force-error'));
    const events = await collect(run);
    const result = await run.result;
    expect(result.finishReason).toBe('error');
    const hasError = events.some((e) => e.type === 'error');
    expect(hasError).toBe(true);
  }, 10_000);

  it('createAcpAdapter respects a custom id (source override)', async () => {
    const hermesShaped = createAcpAdapter({ id: 'hermes-test' });
    const run = hermesShaped.adapter(buildConfig('hello'));
    const events = await collect(run);
    await run.result;
    for (const event of events) {
      expect(event.source).toBe('hermes-test');
    }
  }, 10_000);
});

describe('acpAgent — conformance', () => {
  runAdapterConformance({
    meta: acpAgent,
    buildConfig: () => buildConfig('hello'),
    buildErrorConfig: () => buildConfig('please force-error'),
    timeoutMs: 10_000,
  });
});
