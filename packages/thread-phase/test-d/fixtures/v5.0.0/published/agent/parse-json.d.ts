/**
 * Tolerant JSON parse — strips markdown code fences, falls back to extracting
 * the first {...} object from surrounding prose. Returns the supplied fallback
 * on parse failure.
 *
 * Contract: this function MUST NOT throw. Adversarial agent output (deeply
 * nested structures, malformed prose, megabytes of text) returns the
 * fallback and reports via `onError` (or `console.warn` if no handler).
 *
 * Note on the silent-fallback behavior: when the agent's output was truncated
 * (i.e. `AgentRunResult.finishReason === 'length'`), this almost always
 * fails to parse. Callers should branch on `finishReason` BEFORE trusting
 * the parsed value — otherwise truncation is invisible.
 */
export declare function parseJSON<T>(text: string, fallback: T, onError?: (preview: string, err: Error) => void): T;
/**
 * Strict counterpart to `parseJSON`: same extraction logic (markdown
 * fences, embedded `{...}`, depth guard) but throws on failure instead
 * of returning a fallback. Use this when the caller has already checked
 * `AgentRunResult.finishReason` and KNOWS the response should be valid
 * JSON — surfacing the parse error is more useful than a silent default.
 *
 * Throws `SyntaxError` for malformed JSON; throws `RangeError` if input
 * nesting exceeds MAX_PARSE_DEPTH (mirroring the V8 safeguard in the
 * tolerant variant).
 */
export declare function parseJSONStrict<T>(text: string): T;
//# sourceMappingURL=parse-json.d.ts.map