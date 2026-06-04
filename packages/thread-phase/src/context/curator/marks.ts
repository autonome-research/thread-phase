/**
 * Curator marks — out-of-band per-message tags that drive send-time
 * context shaping.
 *
 * The substrate is a `Map<msgId, Set<tag>>` that some outer process
 * (typically a "curator" agent running on a shadow copy) populates over
 * time with decisions about individual messages. `applyCuratorMarks`
 * reads that map at send time and produces a transformed message list
 * before the request goes to the model.
 *
 * The original messages stay in the caller's store so audit, persistence,
 * and later analysis are unaffected; only the view sent to the model
 * changes.
 *
 * Designed to compose with this package's existing two-layer token
 * defense (`ResultCapper` + `DeterministicCompressor`). The curator
 * substrate is additive — callers can keep both, neither, or any subset.
 *
 * When to use:
 * - You have an external decision-maker that decides per-message what
 *   to drop or reduce (separate from the rigid threshold-driven
 *   compressor).
 * - You want per-message granularity rather than opaque-marker
 *   replacement of whole ranges.
 * - You want decisions auditable separately from the live message list.
 *
 * When NOT to use:
 * - For pure threshold-driven compression where the policy is fixed,
 *   stick with `DeterministicCompressor`. It's simpler, has no external
 *   dependencies, and integrates with `TokenBudgetTracker` directly.
 */

/** Drop the entire message at send time. */
export const MARKED_DROP = 'marked_drop';

/** Replace the message's content with the reducedContent[msgId] entry. */
export const REDUCED = 'reduced';

/**
 * Prefix for "this message has been queued for reduction with strategy X"
 * tags. e.g. `marked_reduce_summarize`, `marked_reduce_head_tail`.
 * The actual reduced content is written separately under `reducedContent`,
 * and the `REDUCED` tag is set when content is available for swap.
 */
export const MARKED_REDUCE_PREFIX = 'marked_reduce_';

/** Diagnostic counts produced by {@link countPendingMarks}. */
export interface MarkCounts {
  /** Messages tagged for full drop. */
  markedDrop: number;
  /** Messages tagged with any `marked_reduce_*` (waiting for content). */
  markedReduce: number;
  /** Messages tagged `reduced` (ready to swap at send time). */
  reduced: number;
}

/**
 * Count messages by curator-mark category. Diagnostic — useful for
 * dashboards and for detecting "the curator decided to reduce things but
 * nothing landed" cases (e.g. apply-time pipeline is disabled, or content
 * was never produced).
 */
export function countPendingMarks(
  messageTags: ReadonlyMap<string, ReadonlySet<string>>,
): MarkCounts {
  const counts: MarkCounts = { markedDrop: 0, markedReduce: 0, reduced: 0 };
  for (const tags of messageTags.values()) {
    if (tags.has(MARKED_DROP)) counts.markedDrop++;
    if (tags.has(REDUCED)) counts.reduced++;
    for (const t of tags) {
      if (t.startsWith(MARKED_REDUCE_PREFIX)) {
        counts.markedReduce++;
        break;
      }
    }
  }
  return counts;
}
