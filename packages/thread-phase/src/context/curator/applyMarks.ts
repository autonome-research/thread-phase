/**
 * Send-time pipeline for curator marks. Pure function — does not mutate
 * input arrays or maps, returns a new array with new wrapper objects for
 * any reduced messages.
 *
 * Call this right before handing the message list to the model. The
 * pipeline reads the same maps that some outer process (the curator)
 * populates over time.
 */

import { MARKED_DROP, REDUCED } from './marks.js';

/**
 * Function for extracting the stable id from a message. Default
 * implementation reads a `msgId` field, but callers can supply their own
 * — e.g., index-based, or pulling from a side-channel map.
 *
 * Returns `undefined` for messages without a stable id (those skip all
 * mark application and pass through verbatim).
 */
export type MessageIdResolver<M> = (message: M, index: number) => string | undefined;

/**
 * Default id resolver — reads `msgId` if present, returns undefined
 * otherwise. Suitable when callers extend their messages with a string
 * `msgId` field.
 *
 * @internal — exposed for tests; most callers use the default.
 */
export function readMsgIdField<M extends { msgId?: string }>(m: M): string | undefined {
  return m.msgId;
}

/**
 * Options for {@link applyCuratorMarks}.
 */
export interface ApplyCuratorMarksOptions<M> {
  /**
   * Extracts a stable id from each message. Defaults to reading a
   * `msgId` field. Provide your own to use a different id scheme (index,
   * WeakMap, hash, etc.).
   */
  getMessageId?: MessageIdResolver<M>;
  /**
   * Master switch. When false, returns a shallow copy of the input
   * unchanged. Useful for shadow-mode rollouts where the curator
   * populates marks but you're not ready to apply them at send time yet.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Apply curator marks to a message list at send time.
 *
 * - Messages tagged `marked_drop` are removed entirely.
 * - Messages tagged `reduced` with a corresponding entry in
 *   `reducedContent` have their `content` swapped for the reduced version.
 * - Everything else passes through unchanged.
 *
 * Pure function — does NOT mutate the input arrays or maps. Returns a
 * new array; reduced messages are shallow-copied so other fields (role,
 * `toolCallId`, etc.) are preserved.
 *
 * Pair-invariant enforcement is the caller's job. Whatever process
 * populates `messageTags` must ensure that all members of any
 * tool-call/tool-result group share the same drop decision. At send
 * time we trust that invariant; mismatched marks may produce malformed
 * tool histories.
 *
 * Fallback safety: a message tagged `reduced` but missing from
 * `reducedContent` passes through with original content (rather than
 * producing an empty message). This makes the pipeline safe to enable
 * before content is reliably populated.
 *
 * @public
 */
export function applyCuratorMarks<M extends { content?: string }>(
  messages: readonly M[],
  messageTags: ReadonlyMap<string, ReadonlySet<string>>,
  reducedContent: ReadonlyMap<string, string>,
  options: ApplyCuratorMarksOptions<M> = {},
): M[] {
  const getMessageId =
    options.getMessageId ?? (readMsgIdField as MessageIdResolver<M>);
  const enabled = options.enabled ?? true;

  if (!enabled || messages.length === 0) {
    return [...messages];
  }

  const out: M[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const mid = getMessageId(msg, i);
    const tags = mid ? messageTags.get(mid) : undefined;

    if (tags && tags.has(MARKED_DROP)) {
      continue;
    }

    if (tags && tags.has(REDUCED) && mid !== undefined) {
      const swap = reducedContent.get(mid);
      if (swap !== undefined) {
        out.push({ ...msg, content: swap } as M);
        continue;
      }
    }

    out.push(msg);
  }
  return out;
}

/** Diagnostic — what the pipeline did on a given invocation. */
export interface ApplyResult<M> {
  /** The transformed message list. */
  messages: M[];
  /** Messages dropped via `marked_drop`. */
  dropped: number;
  /** Messages whose content was swapped via `reduced` + reducedContent. */
  reduced: number;
}

/**
 * Same as {@link applyCuratorMarks} but also reports counts. Useful for
 * structured observability logs without re-walking the list. Otherwise
 * identical behavior.
 *
 * @public
 */
export function applyCuratorMarksWithStats<M extends { content?: string }>(
  messages: readonly M[],
  messageTags: ReadonlyMap<string, ReadonlySet<string>>,
  reducedContent: ReadonlyMap<string, string>,
  options: ApplyCuratorMarksOptions<M> = {},
): ApplyResult<M> {
  const getMessageId =
    options.getMessageId ?? (readMsgIdField as MessageIdResolver<M>);
  const enabled = options.enabled ?? true;

  if (!enabled || messages.length === 0) {
    return { messages: [...messages], dropped: 0, reduced: 0 };
  }

  let dropped = 0;
  let reducedCount = 0;
  const out: M[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const mid = getMessageId(msg, i);
    const tags = mid ? messageTags.get(mid) : undefined;

    if (tags && tags.has(MARKED_DROP)) {
      dropped++;
      continue;
    }

    if (tags && tags.has(REDUCED) && mid !== undefined) {
      const swap = reducedContent.get(mid);
      if (swap !== undefined) {
        out.push({ ...msg, content: swap } as M);
        reducedCount++;
        continue;
      }
    }

    out.push(msg);
  }
  return { messages: out, dropped, reduced: reducedCount };
}
