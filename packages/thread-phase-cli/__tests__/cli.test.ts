/**
 * CLI subcommands — run / serve / list.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { runCli } from '../src/cli.js';
import { Writable } from 'node:stream';

const fixtures = (name: string) => join(import.meta.dirname, 'fixtures', name);

class StringStream extends Writable {
  chunks: string[] = [];
  _write(chunk: Buffer, _enc: string, cb: () => void) {
    this.chunks.push(chunk.toString('utf8'));
    cb();
  }
  text() {
    return this.chunks.join('');
  }
}

describe('runCli', () => {
  it('--help prints usage and returns 0', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['--help'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/automation workflow runner/);
    expect(stdout.text()).toMatch(/run <pipeline-name>/);
  });

  it('list prints registered triggers and pipelines', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['list'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = stdout.text();
    expect(out).toMatch(/triggers \(1\)/);
    expect(out).toMatch(/timer-fast/);
    expect(out).toMatch(/pipelines \(2\)/);
    expect(out).toMatch(/hello\b/);
    expect(out).toMatch(/hello-on-timer.*trigger=timer-fast/);
  });

  it('run executes a registered pipeline and exits 0', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['run', 'hello'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/\[run\] hello/);
    expect(stdout.text()).toMatch(/hello from fixture/);
    expect(stdout.text()).toMatch(/"type":"done"/);
  });

  it('run errors when pipeline name is missing', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['run'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/usage:/);
  });

  it('run errors when pipeline name is unknown', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['run', 'nonexistent'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/no pipeline registered with name "nonexistent"/);
    expect(stderr.text()).toMatch(/available: hello, hello-on-timer/);
  });

  it('unknown subcommand prints usage and returns 1', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['bogus'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/unknown subcommand: bogus/);
  });

  it('serve with no triggered pipelines returns 1', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('manifest'),
      args: ['serve'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/no triggered pipelines/);
  });
});
