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

/**
 * V8's `JSON.parse` is recursive — input nested past ~10k levels can blow
 * the stack with a `RangeError` that is NOT reliably catchable from the
 * surrounding try/catch (the throw happens at a depth where the catch
 * frame itself can't run). We pre-check the candidate string's brace
 * nesting and bail to fallback before calling `JSON.parse` when nesting
 * is adversarially deep. Realistic agent output never approaches this.
 */
const MAX_PARSE_DEPTH = 1000;

export function parseJSON<T>(
  text: string,
  fallback: T,
  onError?: (preview: string, err: Error) => void,
): T {
  try {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const braced = text.match(/(\{[\s\S]*\})/);
    const jsonStr = (fenced ? fenced[1]! : braced ? braced[1]! : text).trim();

    if (exceedsMaxDepth(jsonStr, MAX_PARSE_DEPTH)) {
      return report(
        text,
        new RangeError(
          `parseJSON: input nesting exceeds MAX_PARSE_DEPTH=${MAX_PARSE_DEPTH}`,
        ),
        fallback,
        onError,
      );
    }

    return JSON.parse(jsonStr) as T;
  } catch (err) {
    const errObj = err instanceof Error ? err : new Error(String(err));
    return report(text, errObj, fallback, onError);
  }
}

function report<T>(
  text: string,
  err: Error,
  fallback: T,
  onError?: (preview: string, err: Error) => void,
): T {
  const preview = text.slice(0, 200);
  if (onError) {
    onError(preview, err);
  } else {
    // eslint-disable-next-line no-console
    console.warn(
      `[parseJSON] failed to parse agent output, using fallback. Preview: "${preview}..."`,
      err,
    );
  }
  return fallback;
}

/**
 * O(n) scan tracking string/escape state so braces inside string literals
 * don't inflate the depth count. Returns true as soon as `max` is exceeded —
 * does NOT walk the full input once the verdict is decided.
 */
function exceedsMaxDepth(s: string, max: number): boolean {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === 0x5c /* \ */) escaped = true;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (c === 0x22 /* " */) {
      inString = true;
    } else if (c === 0x7b /* { */ || c === 0x5b /* [ */) {
      if (++depth > max) return true;
    } else if (c === 0x7d /* } */ || c === 0x5d /* ] */) {
      depth--;
    }
  }
  return false;
}
