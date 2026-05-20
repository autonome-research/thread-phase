/**
 * Public API for @autonome-research/thread-phase-cli.
 *
 * Most users only need the `thread-phase` bin and the `ThreadPhaseAPI`
 * type for their extension files. Programmatic embedding of the loader
 * + registry is also supported.
 */

export type {
  ThreadPhaseAPI,
  PipelineSpec,
  ExtensionRegisterFn,
} from './types.js';
export { Registry } from './registry.js';
export {
  loadExtensions,
  EXTENSION_KINDS,
  type LoadOptions,
  type LoadResult,
  type ExtensionKind,
} from './loader.js';
export { runCli, type RunCliOptions } from './cli.js';
