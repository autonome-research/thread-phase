/**
 * Tolerant JSON parse — strips markdown code fences, falls back to extracting
 * the first {...} object from surrounding prose. Returns the supplied fallback
 * on parse failure.
 *
 * Note on the silent-fallback behavior: when the agent's output was truncated
 * (i.e. `AgentRunResult.finishReason === 'length'`), this almost always
 * fails to parse. Callers should branch on `finishReason` BEFORE trusting
 * the parsed value — otherwise truncation is invisible.
 */

export function parseJSON<T>(
  text: string,
  fallback: T,
  onError?: (preview: string, err: Error) => void,
): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const braced = text.match(/(\{[\s\S]*\})/);
  const jsonStr = fenced ? fenced[1]! : braced ? braced[1]! : text;

  try {
    return JSON.parse(jsonStr.trim()) as T;
  } catch (err) {
    const preview = text.slice(0, 200);
    const errObj = err instanceof Error ? err : new Error(String(err));
    if (onError) {
      onError(preview, errObj);
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        `[parseJSON] failed to parse agent output, using fallback. Preview: "${preview}..."`,
        err,
      );
    }
    return fallback;
  }
}
