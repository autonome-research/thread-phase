/**
 * Convenience helpers — `schedule`, `hook`, `oneShot`.
 *
 * Each helper wraps a single handler function into a Phase, then returns
 * an `ExtensionRegisterFn` `(api) => void` that the CLI auto-loader picks
 * up via the file's default export. See each helper file for examples.
 *
 * # API convention
 *
 * Registration helpers use the shape `(spec/handler, options?) =>
 * ExtensionRegisterFn`. The first arg is the meat (a spec object or the
 * handler function); options are secondary. Pipeline name is auto-derived
 * from the calling file via `deriveNameFromCaller`, so you don't pass one
 * explicitly. This is the third of three factory categories in the public
 * API — see AGENTS.md "API conventions — three factory shapes" for how
 * this differs from pattern factories (../patterns) and eager runners.
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
  HookValidationError,
  type HookSpec,
  type HookOptions,
} from './hook.js';
export type {
  ExtensionRegisterFn,
  HelperHandler,
  PipelineSpec,
  ThreadPhaseAPI,
} from './types.js';
