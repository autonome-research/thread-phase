/**
 * Convenience helpers — `schedule`, `hook`, `oneShot`.
 *
 * Each helper wraps a single handler function into a Phase, then returns
 * an `ExtensionRegisterFn` `(api) => void` that the CLI auto-loader picks
 * up via the file's default export. See each helper file for examples.
 */

export { oneShot, type OneShotOptions } from './one-shot.js';
export {
  schedule,
  CronTrigger,
  type ScheduleSpec,
  type ScheduleOptions,
} from './schedule.js';
export {
  hook,
  HttpTrigger,
  type HookSpec,
  type HookOptions,
} from './hook.js';
export type {
  ExtensionRegisterFn,
  HelperHandler,
  PipelineSpec,
  ThreadPhaseAPI,
} from './types.js';
