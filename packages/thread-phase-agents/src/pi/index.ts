/**
 * Pi adapter entry. In-process via `@mariozechner/pi-coding-agent`.
 *
 * The first adapter in this package that natively supports
 * `SteerableAgentRun.steer()` and `.followUp()`. Use `isSteerable`
 * from `thread-phase/agents` to narrow at the call site:
 *
 *     const run = piAgent.adapter({ cwd, prompt });
 *     if (isSteerable(run)) await run.steer('reconsider this');
 *
 * @internal
 */

export { piAgent, type PiAgentConfig } from './adapter.js';
