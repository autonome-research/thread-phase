/**
 * Curator substrate — per-message tagging + send-time apply pipeline +
 * pluggable reduction strategies.
 *
 * Composes with this package's existing token defense (`ResultCapper`,
 * `DeterministicCompressor`); see ../README for the integration story.
 */

export {
  MARKED_DROP,
  REDUCED,
  MARKED_REDUCE_PREFIX,
  countPendingMarks,
  type MarkCounts,
} from './marks.js';

export {
  applyCuratorMarks,
  applyCuratorMarksWithStats,
  readMsgIdField,
  type MessageIdResolver,
  type ApplyCuratorMarksOptions,
  type ApplyResult,
} from './applyMarks.js';

export {
  reduceHeadTail,
  reduceFirstNChars,
  reduceSchemaOnly,
  reduceSummarize,
  reduceSync,
  reduceAsync,
  isAsyncStrategy,
  type HeadTailOptions,
  type FirstNCharsOptions,
  type SummarizeOptions,
  type ReductionStrategyName,
} from './reduce.js';
