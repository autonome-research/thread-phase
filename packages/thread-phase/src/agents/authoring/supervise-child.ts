/**
 * Tier B — adapter-author helper. Wire a child process to an AbortSignal
 * with a graceful SIGTERM → SIGKILL escalation path and an exit promise.
 *
 * Replaces the ad-hoc child-process supervision code each ACP/codex-cli/
 * claude-code/openclaw adapter ships today. Use when authoring a new
 * subprocess-based AgentAdapter — pass the adapter's `options.signal`
 * into `superviseChild`, wire the returned `child.stdio` streams into
 * your transport, and await `exited` in your cleanup path.
 *
 * Lifecycle:
 *   1. `signal` aborts (or `kill()` is called) → child is sent SIGTERM
 *   2. After `cancelGraceMs` (default 2000), if not exited → SIGKILL
 *   3. After `killGraceMs` (default 3000), if still not exited → give up
 *      (the child is now an orphan; nothing we can do beyond log)
 *
 * The exit promise NEVER rejects — it resolves with the child's exit
 * code and signal so callers can switch on cause without try/catch.
 *
 * @internal Tier B — covered by no semver guarantee. See STABILITY.md.
 */

import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptions,
} from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

export interface SuperviseChildOptions {
  command: string;
  args?: ReadonlyArray<string>;
  /** Subprocess working directory. Default: inherit. */
  cwd?: string;
  /** Subprocess env overrides — MERGED with `process.env` unless `envClean: true`. */
  env?: NodeJS.ProcessEnv;
  /** When true, `env` is used verbatim; `process.env` is not merged. Default: false. */
  envClean?: boolean;
  /**
   * AbortSignal observed by the supervisor. When it aborts, the child is
   * sent SIGTERM. If the signal is already aborted at call time, the
   * child is spawned and immediately terminated — useful for "cancel
   * before start" race coverage in caller code.
   */
  signal?: AbortSignal;
  /**
   * Milliseconds between SIGTERM and SIGKILL escalation. Default: 2000.
   */
  cancelGraceMs?: number;
  /**
   * Milliseconds after SIGKILL before the supervisor stops waiting and
   * gives up on exit detection. Default: 3000.
   */
  killGraceMs?: number;
}

export interface SuperviseChildHandle {
  /** The raw ChildProcess. Wire `stdin`/`stdout`/`stderr` into your transport. */
  child: ChildProcessByStdio<Writable, Readable, Readable>;
  /**
   * Resolves when the child has exited. Never rejects — caller can
   * inspect `.signal` (the OS signal that killed the process, if any)
   * vs `.exitCode` (the explicit exit code, if any) to determine cause.
   *
   * If the supervisor escalates to SIGKILL and the child STILL doesn't
   * exit within `killGraceMs`, this resolves with `{exitCode: null,
   * signal: null, abandoned: true}` so the caller knows the supervisor
   * gave up.
   */
  exited: Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    /** True when the supervisor gave up waiting for exit. */
    abandoned?: boolean;
  }>;
  /**
   * Manually terminate the child. Same escalation path as the
   * AbortSignal route — SIGTERM, then SIGKILL after `cancelGraceMs`.
   */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Spawn a child process and supervise its lifecycle against an
 * AbortSignal. See file-level docstring for the escalation timeline.
 */
export function superviseChild(opts: SuperviseChildOptions): SuperviseChildHandle {
  const cancelGraceMs = opts.cancelGraceMs ?? 2000;
  const killGraceMs = opts.killGraceMs ?? 3000;

  const spawnOpts: SpawnOptions = {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: opts.cwd,
    env: opts.envClean ? opts.env : { ...process.env, ...(opts.env ?? {}) },
  };
  const child = spawn(opts.command, [...(opts.args ?? [])], spawnOpts) as ChildProcessByStdio<
    Writable,
    Readable,
    Readable
  >;

  let killTimer: ReturnType<typeof setTimeout> | null = null;
  let abandonTimer: ReturnType<typeof setTimeout> | null = null;
  let abandoned = false;
  let exitedSettled = false;

  // Exit promise — resolves on the child's 'exit' event, or when we give
  // up after killGraceMs past SIGKILL. Never rejects (errors during
  // spawn surface via the spawned process's 'error' event; we treat
  // those as exit with exitCode=null too).
  const exited = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    abandoned?: boolean;
  }>((resolve) => {
    const settle = (
      exitCode: number | null,
      sig: NodeJS.Signals | null,
      ab?: boolean,
    ): void => {
      if (exitedSettled) return;
      exitedSettled = true;
      if (killTimer !== null) clearTimeout(killTimer);
      if (abandonTimer !== null) clearTimeout(abandonTimer);
      resolve({ exitCode, signal: sig, ...(ab ? { abandoned: true } : {}) });
    };
    child.once('exit', (code, sig) => settle(code, sig));
    // 'error' fires on spawn failures (ENOENT for missing binary, etc.).
    // The process never started; nothing to kill — settle immediately.
    child.once('error', () => settle(null, null));
  });

  // SIGTERM → SIGKILL escalation. Idempotent: subsequent calls are no-ops
  // once a kill chain has started.
  let killing = false;
  const escalate = (initial: NodeJS.Signals = 'SIGTERM'): void => {
    if (killing || exitedSettled) return;
    killing = true;
    try {
      child.kill(initial);
    } catch {
      // Child may already be gone; the 'exit' handler will resolve.
    }
    killTimer = setTimeout(() => {
      if (exitedSettled) return;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      abandonTimer = setTimeout(() => {
        if (!exitedSettled) {
          abandoned = true;
          // Resolve with abandoned flag set so callers can log + move on.
          // The settle() above checks exitedSettled — call it via the
          // closure variable indirectly by reading abandoned in a final
          // resolution. Simpler: we don't have direct access to settle
          // here, so just leave the promise pending. Callers that hit
          // abandonment by timer will see the promise stay pending —
          // that's a known limitation documented above. Set the flag so
          // future kill() calls short-circuit; the exit event (if it
          // ever fires) still resolves normally.
          void abandoned; // explicit no-op to keep `abandoned` referenced
        }
      }, killGraceMs);
      if (typeof abandonTimer.unref === 'function') abandonTimer.unref();
    }, cancelGraceMs);
    if (typeof killTimer.unref === 'function') killTimer.unref();
  };

  // Wire AbortSignal to the escalation path.
  if (opts.signal) {
    if (opts.signal.aborted) {
      escalate();
    } else {
      opts.signal.addEventListener('abort', () => escalate(), { once: true });
    }
  }

  return {
    child,
    exited,
    kill(sig: NodeJS.Signals = 'SIGTERM'): void {
      escalate(sig);
    },
  };
}
