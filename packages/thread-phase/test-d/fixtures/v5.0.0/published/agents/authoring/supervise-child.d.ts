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
import { type ChildProcessByStdio } from 'node:child_process';
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
export declare function superviseChild(opts: SuperviseChildOptions): SuperviseChildHandle;
//# sourceMappingURL=supervise-child.d.ts.map