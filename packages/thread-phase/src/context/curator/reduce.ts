/**
 * Reduction strategies — pure transformations from one string of message
 * content to a shorter one. Each strategy targets a different content
 * shape; pick by name or compose your own via the same signature.
 *
 * - {@link reduceHeadTail} — keep first N + last M lines, drop middle
 * - {@link reduceFirstNChars} — character prefix at structural boundary
 * - {@link reduceSchemaOnly} — JSON shape + one sample per array
 * - {@link reduceSummarize} — async, LLM-backed structured summary
 *
 * The strategies are decoupled from any specific scheduling / marking
 * layer. They take a string in and return a string out. Compose with
 * {@link applyCuratorMarks} via a `Map<msgId, string>` of reduced
 * content, or call directly when you already know which message to
 * reduce.
 */

import type OpenAI from 'openai';

// ---------------------------------------------------------------------------
// head_tail
// ---------------------------------------------------------------------------

export interface HeadTailOptions {
  /** Lines kept at the start. Default 30. */
  headLines?: number;
  /** Lines kept at the end. Default 15. */
  tailLines?: number;
}

/**
 * Keep first `headLines` + last `tailLines`, drop the middle with an
 * elision marker. Returns the original content unchanged if the line
 * count is already at or below the kept window.
 *
 * Best for file reads and command output where structural beginning and
 * end carry the most signal. No-op on short content — safe to call
 * unconditionally.
 *
 * @public
 */
export function reduceHeadTail(content: string, options: HeadTailOptions = {}): string {
  const headLines = options.headLines ?? 30;
  const tailLines = options.tailLines ?? 15;

  const lines = content.split('\n');
  const keep = headLines + tailLines;
  if (lines.length <= keep + 1) {
    return content;
  }
  const middleDropped = lines.length - keep;
  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);
  const marker = `... [${middleDropped} lines elided] ...`;
  return [...head, marker, ...tail].join('\n');
}

// ---------------------------------------------------------------------------
// first_n_chars
// ---------------------------------------------------------------------------

/**
 * Substrings indicating a "safe" structural boundary near the cutoff —
 * preference order: blank line > line break > sentence end > word break.
 */
const BOUNDARY_STRINGS: ReadonlyArray<string> = ['\n\n', '\n', '. ', ' '];

export interface FirstNCharsOptions {
  /** Target maximum character count. Default 2000. */
  nChars?: number;
}

/**
 * Truncate to roughly `nChars` characters at the nearest structural
 * boundary before the cutoff. Never lands mid-word if avoidable, and
 * avoids leaving an open ``` code fence by stripping the dangling opener.
 *
 * Returns the original content unchanged if it's already short enough.
 *
 * @public
 */
export function reduceFirstNChars(content: string, options: FirstNCharsOptions = {}): string {
  const nChars = options.nChars ?? 2000;
  if (content.length <= nChars) {
    return content;
  }

  let cutoff = nChars;
  for (const boundary of BOUNDARY_STRINGS) {
    const idx = content.lastIndexOf(boundary, nChars);
    if (idx > nChars * 0.5) {
      cutoff = idx + boundary.length;
      break;
    }
  }

  let truncated = content.slice(0, cutoff);
  const fenceCount = (truncated.match(/```/g) ?? []).length;
  if (fenceCount % 2 === 1) {
    const lastFence = truncated.lastIndexOf('```');
    truncated = truncated.slice(0, lastFence).replace(/\s+$/, '');
  }

  const charsDropped = content.length - truncated.length;
  return `${truncated.replace(/\s+$/, '')}\n\n... [${charsDropped} chars truncated]`;
}

// ---------------------------------------------------------------------------
// schema_only
// ---------------------------------------------------------------------------

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function summarizeValue(v: JsonValue, depth = 0, maxDepth = 3): JsonValue {
  if (depth >= maxDepth) {
    if (Array.isArray(v)) return '<array truncated>';
    if (typeof v === 'object' && v !== null) return '<object truncated>';
    return v;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return [];
    if (v.length === 1) return [summarizeValue(v[0]!, depth + 1, maxDepth)];
    return [
      summarizeValue(v[0]!, depth + 1, maxDepth),
      `<${v.length - 1} more items>`,
    ];
  }
  if (typeof v === 'object' && v !== null) {
    const out: { [key: string]: JsonValue } = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = summarizeValue(val, depth + 1, maxDepth);
    }
    return out;
  }
  if (typeof v === 'string' && v.length > 80) {
    return `${v.slice(0, 80)}...`;
  }
  return v;
}

/**
 * For JSON content, keep the schema (key names, types) and replace
 * large arrays with `[firstItem, "<N more items>"]`. For non-JSON or
 * malformed JSON, falls back to {@link reduceHeadTail}.
 *
 * The reduced output is itself valid JSON (a structural summary) so
 * downstream parsers don't break on the reduced form.
 *
 * @public
 */
export function reduceSchemaOnly(content: string): string {
  const text = content.trim();

  let parsed: JsonValue | undefined;
  let prefix = '';

  try {
    parsed = JSON.parse(text) as JsonValue;
  } catch {
    const candidates = [text.indexOf('{'), text.indexOf('[')].filter((i) => i >= 0);
    if (candidates.length === 0) {
      return reduceHeadTail(content);
    }
    const jsonStart = Math.min(...candidates);
    try {
      parsed = JSON.parse(text.slice(jsonStart)) as JsonValue;
      prefix = text.slice(0, jsonStart).trim();
    } catch {
      return reduceHeadTail(content);
    }
  }

  if (parsed === undefined) {
    return reduceHeadTail(content);
  }

  const summary = summarizeValue(parsed);
  const summaryJson = JSON.stringify(summary, null, 2);
  if (prefix) {
    return `${prefix}\n${summaryJson}\n[schema_only reduction]`;
  }
  return `${summaryJson}\n[schema_only reduction]`;
}

// ---------------------------------------------------------------------------
// summarize (async, LLM-backed)
// ---------------------------------------------------------------------------

export interface SummarizeOptions {
  /**
   * OpenAI-compatible client. If absent, falls back to head_tail.
   * The framework already depends on the `openai` package so any
   * OpenAI / OpenAI-compatible (vLLM, Ollama, llama.cpp, LM Studio)
   * endpoint works.
   */
  client?: OpenAI;
  /** Model name. Required if `client` is provided. */
  model?: string;
  /**
   * Cap input content length before sending to the model. Default 32000
   * chars — enough for any reasonable tool result.
   */
  maxInputChars?: number;
}

const DEFAULT_SUMMARIZE_SYSTEM = (
  'You are a content summariser. Given a tool or agent output, produce a ' +
  'tight structured summary that preserves identifiers, paths, errors, and ' +
  'key facts. Drop verbose narrative and example data. Output ONLY the ' +
  'summary — no preamble.'
);

/**
 * LLM-backed structured summary. Asynchronous and the only strategy
 * that needs network access. Falls back to head_tail when no client is
 * provided or when the call fails or returns empty content.
 *
 * Suitable for prose-heavy content (long agent returns, narrative tool
 * results) where structural strategies discard too much. Prefer a sync
 * strategy when one fits — they're cheaper and don't depend on inference.
 *
 * @public
 */
export async function reduceSummarize(
  content: string,
  options: SummarizeOptions = {},
): Promise<string> {
  const { client, model, maxInputChars = 32000 } = options;
  if (client === undefined || model === undefined) {
    return reduceHeadTail(content);
  }

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: DEFAULT_SUMMARIZE_SYSTEM },
        { role: 'user', content: content.slice(0, maxInputChars) },
      ],
    });
    const summary = response.choices[0]?.message?.content?.trim() ?? '';
    if (summary.length === 0) {
      return reduceHeadTail(content);
    }
    return `${summary}\n\n[summarize reduction of ${content.length} chars]`;
  } catch {
    return reduceHeadTail(content);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/** Canonical names for the built-in strategies. */
export type ReductionStrategyName =
  | 'head_tail'
  | 'first_n_chars'
  | 'schema_only'
  | 'summarize';

/** True if the named strategy is async (i.e. returns a Promise). */
export function isAsyncStrategy(name: string): boolean {
  return name === 'summarize';
}

/**
 * Dispatch a synchronous strategy by name. Returns `undefined` if the
 * name is not a known synchronous strategy.
 *
 * @public
 */
export function reduceSync(name: string, content: string): string | undefined {
  switch (name) {
    case 'head_tail':
      return reduceHeadTail(content);
    case 'first_n_chars':
      return reduceFirstNChars(content);
    case 'schema_only':
      return reduceSchemaOnly(content);
    default:
      return undefined;
  }
}

/**
 * Dispatch an async strategy by name. Returns `undefined` if the name
 * is not a known async strategy. (Sync strategies are not awaitable
 * through this entry point — use {@link reduceSync} for those.)
 *
 * @public
 */
export async function reduceAsync(
  name: string,
  content: string,
  options?: SummarizeOptions,
): Promise<string | undefined> {
  if (name === 'summarize') {
    return reduceSummarize(content, options);
  }
  return undefined;
}
