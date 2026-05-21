/**
 * CLI subcommands — run / serve / list.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import { runCli } from '../src/cli.js';

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

  it('--version prints the package version and returns 0', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['--version'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/^thread-phase \d+\.\d+\.\d+/);
  });

  it('-v at top level prints version (not list --verbose)', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['-v'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/^thread-phase \d+\.\d+\.\d+/);
  });

  it('list in a dir with no .thread-phase/ prints a how-to-get-started hint', async () => {
    // Use /tmp as cwd — a dir that definitely has no .thread-phase/.
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: '/tmp',
      args: ['list'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = stdout.text();
    expect(out).toMatch(/No \.thread-phase\/ directory found here/);
    expect(out).toMatch(/EXTENDING\.md/);
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

  it('list --verbose shows phases/ctx kind and trigger class', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['list', '--verbose'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = stdout.text();
    // hello pipeline: phases is a literal array, ctx is literal.
    expect(out).toMatch(/hello\b[\s\S]*?phases: +array/);
    expect(out).toMatch(/hello\b[\s\S]*?ctx: +literal/);
    // hello-on-timer pipeline: ctx is factory.
    expect(out).toMatch(/hello-on-timer[\s\S]*?ctx: +factory/);
    // trigger class is reported.
    expect(out).toMatch(/timer-fast[\s\S]*?class: +TimerTrigger/);
  });

  it('list --verbose shows pipeline source path indented', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['list', '--verbose'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = stdout.text();
    // Verbose output should include indented source: line under each pipeline.
    expect(out).toMatch(/hello\b[\s\S]*?\n {4}source: .*pipelines\/hello\.ts/);
  });

  it('run --input parses inline JSON and overrides defaultInput', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('input'),
      args: ['run', 'echo', '--input', '{"source":"inline"}'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    const out = stdout.text();
    expect(out).toMatch(/"value":"\{\\"source\\":\\"inline\\"\}"/);
    // The default { source: 'default' } must NOT appear in the data event.
    expect(out).not.toMatch(/\{\\"source\\":\\"default\\"\}/);
  });

  it('run --input @file reads JSON from a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tp-cli-input-'));
    const path = join(dir, 'in.json');
    writeFileSync(path, '{"source":"file"}');
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('input'),
      args: ['run', 'echo', '--input', `@${path}`],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/"value":"\{\\"source\\":\\"file\\"\}"/);
  });

  it('run --input - reads JSON from stdin', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const stdin = Readable.from(['{"source":"', 'stdin"}']);
    const code = await runCli({
      cwd: fixtures('input'),
      args: ['run', 'echo', '--input', '-'],
      stdout,
      stderr,
      stdin,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/"value":"\{\\"source\\":\\"stdin\\"\}"/);
  });

  it('run --input with invalid JSON returns exit 1 and writes to stderr', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('input'),
      args: ['run', 'echo', '--input', '{not json'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/invalid --input/);
  });

  it('run --input with missing file returns exit 1', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('input'),
      args: ['run', 'echo', '--input', '@/no/such/file.json'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/could not read file/);
  });

  it('serve --health-port responds 200 ok while running', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const abort = new AbortController();
    // Pick a high-numbered ephemeral port to avoid collisions.
    const port = 38751;
    const servePromise = runCli({
      cwd: fixtures('basic'),
      args: ['serve', '--health-port', String(port)],
      stdout,
      stderr,
      abortSignal: abort.signal,
    });

    // Wait for the health server to be reachable.
    let body: { status: string } | null = null;
    let status = 0;
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        status = res.status;
        body = (await res.json()) as { status: string };
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'ok' });

    abort.abort();
    await servePromise;
  }, 5000);

  it('serve --health-port responds 503 shutting_down during drain', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const abort = new AbortController();
    const port = 38752;
    const servePromise = runCli({
      cwd: fixtures('slow-stop'),
      args: ['serve', '--health-port', String(port)],
      stdout,
      stderr,
      abortSignal: abort.signal,
    });

    // Wait for health endpoint to come up.
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }

    // Trigger shutdown — the slow-stop trigger holds for ~300ms in stop().
    abort.abort();
    // Briefly wait so the abort handler runs and flips `serving` off.
    await new Promise((r) => setTimeout(r, 50));

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: 'shutting_down' });

    await servePromise;
  }, 5000);

  it('serve --health-port closes the health server when serve exits', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const abort = new AbortController();
    const port = 38753;
    const servePromise = runCli({
      cwd: fixtures('basic'),
      args: ['serve', '--health-port', String(port)],
      stdout,
      stderr,
      abortSignal: abort.signal,
    });
    // Wait for health endpoint to come up.
    for (let i = 0; i < 50; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`);
        if (res.status === 200) break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    abort.abort();
    await servePromise;

    // After serve exits, the port should no longer accept connections.
    let connected = true;
    try {
      await fetch(`http://127.0.0.1:${port}/health`);
    } catch {
      connected = false;
    }
    expect(connected).toBe(false);
  }, 5000);

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

  it('init in empty cwd scaffolds .thread-phase/ + sample + package.json', async () => {
    const { mkdtempSync, existsSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'tp-init-empty-'));

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: dir,
      args: ['init'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(existsSync(join(dir, '.thread-phase', 'triggers'))).toBe(true);
    expect(existsSync(join(dir, '.thread-phase', 'adapters'))).toBe(true);
    expect(existsSync(join(dir, '.thread-phase', 'pipelines'))).toBe(true);
    expect(existsSync(join(dir, '.thread-phase', 'lib'))).toBe(true);
    expect(existsSync(join(dir, '.thread-phase', 'pipelines', 'hello.ts'))).toBe(true);
    expect(existsSync(join(dir, 'package.json'))).toBe(true);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      type?: string;
      dependencies?: Record<string, string>;
    };
    expect(pkg.type).toBe('module');
    expect(pkg.dependencies?.['@autonome-research/thread-phase-cli']).toMatch(/^\^?\d+\.\d+\.\d+/);

    expect(stdout.text()).toMatch(/thread-phase initialized at/);
    expect(stdout.text()).toMatch(/thread-phase run hello/);
  });

  it('init keeps an existing package.json untouched', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'tp-init-existingpkg-'));
    const userPkg = JSON.stringify({ name: 'my-app', version: '1.2.3' });
    writeFileSync(join(dir, 'package.json'), userPkg);

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: dir,
      args: ['init'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(userPkg);
  });

  it('init <name> creates a subdir and scaffolds inside', async () => {
    const { mkdtempSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const parent = mkdtempSync(join(tmpdir(), 'tp-init-subdir-'));

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: parent,
      args: ['init', 'my-proj'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    expect(existsSync(join(parent, 'my-proj', '.thread-phase', 'pipelines', 'hello.ts'))).toBe(true);
    expect(stdout.text()).toMatch(/cd my-proj/);
  });

  it('init refuses when target directory already exists', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const parent = mkdtempSync(join(tmpdir(), 'tp-init-exists-'));
    mkdirSync(join(parent, 'already-there'));

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: parent,
      args: ['init', 'already-there'],
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/already exists/);
  });

  it('init refuses when .thread-phase/ already exists', async () => {
    const { mkdtempSync, mkdirSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'tp-init-already-init-'));
    mkdirSync(join(dir, '.thread-phase'));

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: dir,
      args: ['init'],
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toMatch(/already initialized/);
  });

  it('walks up from a subdir to find .thread-phase/ in an ancestor', async () => {
    const { mkdirSync } = await import('node:fs');
    const subdir = join(fixtures('basic'), 'deep', 'nested', 'cwd');
    mkdirSync(subdir, { recursive: true });

    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: subdir,
      args: ['list'],
      stdout,
      stderr,
    });

    expect(code).toBe(0);
    const out = stdout.text();
    expect(out).toMatch(/Loading extensions from .*fixtures\/basic\/\.thread-phase/);
    expect(out).toMatch(/timer-fast/);  // proves extensions actually loaded
  });

  it('list prints a "Loaded N extensions" summary', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['list'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
    expect(stdout.text()).toMatch(/Loaded \d+ extension/);
  });

  it('--strict exits 0 when no load failures', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('basic'),
      args: ['--strict', 'list'],
      stdout,
      stderr,
    });
    expect(code).toBe(0);
  });

  it('--strict exits 1 when any extension fails to load', async () => {
    const stdout = new StringStream();
    const stderr = new StringStream();
    const code = await runCli({
      cwd: fixtures('broken'),
      args: ['--strict', 'list'],
      stdout,
      stderr,
    });
    expect(code).toBe(1);
    expect(stdout.text()).toMatch(/failed:/);
  });
});
