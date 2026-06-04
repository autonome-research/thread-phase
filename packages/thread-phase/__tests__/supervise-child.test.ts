/**
 * Tests for the v4.1.0 superviseChild helper in agents/authoring.
 * Uses small `node -e ...` subprocesses since they're available on every
 * environment thread-phase targets (Node ≥20).
 */

import { describe, it, expect } from 'vitest';
import { superviseChild } from '../src/agents/authoring/supervise-child.js';

describe('superviseChild — happy path', () => {
  it('spawns the child and resolves exited with the natural exit code', async () => {
    const h = superviseChild({
      command: 'node',
      args: ['-e', 'process.exit(0)'],
    });
    const r = await h.exited;
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();
    expect(r.abandoned).toBeUndefined();
  });

  it('captures a non-zero natural exit code', async () => {
    const h = superviseChild({
      command: 'node',
      args: ['-e', 'process.exit(42)'],
    });
    const r = await h.exited;
    expect(r.exitCode).toBe(42);
  });
});

describe('superviseChild — abort path', () => {
  it('SIGTERMs the child when the external signal aborts', async () => {
    const controller = new AbortController();
    // A child that ignores SIGTERM-via-default would hang; the default
    // Node behavior is to exit on SIGTERM though, so this is sufficient.
    const h = superviseChild({
      command: 'node',
      args: ['-e', 'setInterval(()=>{}, 100)'],
      signal: controller.signal,
      cancelGraceMs: 500,
      killGraceMs: 500,
    });

    // Give the child a beat to start, then abort.
    await new Promise((r) => setTimeout(r, 50));
    controller.abort('test');

    const r = await h.exited;
    expect(r.signal).toBe('SIGTERM');
    expect(r.exitCode).toBeNull();
  });

  it('SIGKILLs after cancelGraceMs when the child ignores SIGTERM', async () => {
    const controller = new AbortController();
    // Child that traps SIGTERM and keeps running.
    const h = superviseChild({
      command: 'node',
      args: [
        '-e',
        "process.on('SIGTERM', () => { /* swallow */ }); setInterval(()=>{}, 100);",
      ],
      signal: controller.signal,
      cancelGraceMs: 300,
      killGraceMs: 1000,
    });

    await new Promise((r) => setTimeout(r, 100));
    controller.abort('test');

    const r = await h.exited;
    expect(r.signal).toBe('SIGKILL');
  });

  it('escalates immediately when the signal is already aborted at call time', async () => {
    const controller = new AbortController();
    controller.abort('pre-aborted');
    const h = superviseChild({
      command: 'node',
      args: ['-e', 'setInterval(()=>{}, 100)'],
      signal: controller.signal,
      cancelGraceMs: 500,
    });
    const r = await h.exited;
    expect(['SIGTERM', 'SIGKILL']).toContain(r.signal);
  });
});

describe('superviseChild — manual kill', () => {
  it('kill() with no signal sends SIGTERM', async () => {
    const h = superviseChild({
      command: 'node',
      args: ['-e', 'setInterval(()=>{}, 100)'],
      cancelGraceMs: 500,
    });
    await new Promise((r) => setTimeout(r, 50));
    h.kill();
    const r = await h.exited;
    expect(r.signal).toBe('SIGTERM');
  });
});

describe('superviseChild — spawn failure', () => {
  it('resolves exited with null code/signal when spawn fails (ENOENT)', async () => {
    const h = superviseChild({
      command: '/path/to/binary/that/does/not/exist/at/all',
    });
    const r = await h.exited;
    expect(r.exitCode).toBeNull();
    expect(r.signal).toBeNull();
  });
});
