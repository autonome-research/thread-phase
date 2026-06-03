/**
 * Prompted structured-output helpers.
 *
 * Adapters that declare `structuredOutput: 'prompted'` cannot ask the
 * underlying runtime for a JSON-schema-constrained response, so they instead
 * inject an instruction into the system prompt and parse the agent's final
 * text afterward. This module owns both halves: `applyStructuredOutputPrompt`
 * augments the prompt; `parseStructuredFromText` (and the convenience
 * `parseStructured`) extract and validate the payload.
 *
 * The contract: the agent emits its final answer inside a single
 * `<response>...</response>` block. Free-form reasoning may precede it.
 * Retries on parse failure are not executed here — that is an adapter-level
 * concern (the adapter calls `followUp()` with the parse error and retries).
 *
 * # Stability — this file straddles the tier boundary
 *
 *   - `StructuredOutputConfig` and `StructuredOutputParseError` are
 *     Tier A (stable from v4.0.0). Consumers declare the config shape in
 *     adapter options; they must handle the error type from
 *     `AgentRunResult.parseError`. Re-exported from `thread-phase/agents`.
 *
 *   - `applyStructuredOutputPrompt`, `extractResponseBlock`,
 *     `parseStructuredFromText`, `parseStructured` are Tier B (author-
 *     unstable). They are implementation helpers for adapters wiring the
 *     prompted-output path. Re-exported from `thread-phase/agents/authoring`.
 *
 *     NOTE: `parseStructuredFromText` is the closest Tier B export to a
 *     Tier A candidate — six bundled adapters use it. If consumer-facing
 *     re-parse of a raw response ever becomes a documented use case
 *     (e.g. retry-from-cached-text flows), promote it via a stable wrapper.
 */

import type { AgentRunResult } from './protocol.js';

/**
 * Configuration for the prompted structured-output path.
 */
export interface StructuredOutputConfig {
  /**
   * JSON Schema describing the expected payload, or a free-form description
   * string. Used to render the instruction; not validated by this module —
   * callers supply `validate` if they want a check.
   */
  schema: Record<string, unknown> | string;
  /**
   * Optional caller-supplied validator. When provided, `parseStructured`
   * runs it on the extracted JSON and throws `StructuredOutputParseError`
   * if it returns false. Default is identity (no validation).
   */
  validate?: (data: unknown) => boolean;
  /**
   * Retries are NOT executed by this module — they are an adapter-level
   * concern. Documented here so adapters can read the intended count.
   * Default: 1.
   */
  retries?: number;
}

/**
 * Distinct error for the prompted-output path. Carries the offending text
 * window so callers can decide whether to retry.
 */
export class StructuredOutputParseError extends Error {
  constructor(message: string, public window: string) {
    super(message);
    this.name = 'StructuredOutputParseError';
  }
}

/**
 * Append the prompted-output instruction to a system prompt. The instruction
 * tells the agent to emit a single `<response>...</response>` block whose
 * contents are JSON conforming to the schema, after any free-form text.
 *
 * String schemas are embedded verbatim; object schemas are JSON-stringified
 * with 2-space indent. The instruction is separated from the existing prompt
 * by a blank line.
 *
 * @internal
 */
export function applyStructuredOutputPrompt(
  systemPrompt: string,
  spec: StructuredOutputConfig,
): string {
  const schemaText =
    typeof spec.schema === 'string' ? spec.schema : JSON.stringify(spec.schema, null, 2);
  const instruction =
    'When finished, emit your final answer as a single <response>...</response> block ' +
    'whose contents are valid JSON conforming to:\n' +
    schemaText +
    '\nDo not include any text after the closing tag.';
  const base = systemPrompt.trimEnd();
  return base.length > 0 ? `${base}\n\n${instruction}` : instruction;
}

/**
 * Extract the last `<response>...</response>` block from arbitrary text.
 * Returns the inner content (trimmed) on match, or `null` when no block is
 * present. Taking the LAST match makes the parser robust to wrapped thinking
 * and accidental example tags earlier in the output.
 *
 * @internal
 */
export function extractResponseBlock(text: string): string | null {
  const re = /<response>([\s\S]*?)<\/response>/g;
  let last: string | null = null;
  for (const match of text.matchAll(re)) {
    last = match[1] ?? '';
  }
  return last === null ? null : last.trim();
}

/**
 * Extract, parse, and optionally validate a structured payload from arbitrary
 * agent text. Throws `StructuredOutputParseError` on extraction failure, JSON
 * parse failure, or validator rejection.
 *
 * @internal
 */
export function parseStructuredFromText(
  text: string,
  spec: StructuredOutputConfig,
): unknown {
  const block = extractResponseBlock(text);
  if (block === null) {
    throw new StructuredOutputParseError('no <response> block in output', text.slice(-500));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    throw new StructuredOutputParseError('invalid JSON in <response>', block);
  }
  if (spec.validate && !spec.validate(parsed)) {
    throw new StructuredOutputParseError('payload rejected by validator', block);
  }
  return parsed;
}

/**
 * Convenience wrapper: same as `parseStructuredFromText` but reads the text
 * from a completed `AgentRunResult`.
 *
 * @internal
 */
export function parseStructured(
  result: AgentRunResult,
  spec: StructuredOutputConfig,
): unknown {
  return parseStructuredFromText(result.text, spec);
}
