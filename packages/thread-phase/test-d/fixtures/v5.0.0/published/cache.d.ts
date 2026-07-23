/**
 * Pipeline-scoped cache — shared across phases and tool calls within a single
 * pipeline run. Avoids redundant work when multiple phases (or multiple
 * parallel agents within a phase) read the same data.
 *
 * Created per-pipeline, cleared on completion.
 *
 * Namespacing: `cache.namespace('foo')` returns a sub-cache that prefixes all
 * keys with `foo:`. Use this when two unrelated callers might pick the same
 * key (e.g. `chunk:0`) to keep their entries isolated. Sub-caches share the
 * underlying store, so `clear()` and `size` see all entries; `clear()` on a
 * sub-cache only drops keys in that namespace.
 */
export declare class PipelineCache {
    private readonly store;
    private readonly pending;
    private readonly prefix;
    constructor(store?: Map<string, unknown>, prefix?: string, pending?: Map<string, Promise<unknown>>);
    private k;
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    has(key: string): boolean;
    /**
     * Cache-or-fetch.
     *
     * Concurrent callers on the same key share one in-flight fetch — the
     * second-through-Nth caller awaits the first caller's promise instead of
     * each running its own. This preserves the cache's central invariant
     * (one fetch per key per pipeline run) under fanout.
     *
     * On fetcher rejection the pending entry is evicted so the next caller
     * may retry; rejections are NOT cached.
     */
    getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T>;
    /**
     * Clear cache entries.
     *
     * On the root cache: drops every entry.
     * On a namespaced sub-cache: drops only entries whose keys start with this
     * namespace's prefix; entries belonging to the root cache or other
     * namespaces are untouched.
     */
    clear(): void;
    /**
     * Total entries in the underlying store, across all namespaces. This is
     * shared state; a sub-cache reports the same number as the root.
     */
    get size(): number;
    /**
     * Return a sub-cache that prefixes all keys with `${name}:`. Sub-caches
     * are cheap (no copy) and share the underlying store.
     *
     * Nesting is supported: `cache.namespace('a').namespace('b')` prefixes
     * with `a:b:`. Empty names are rejected.
     */
    namespace(name: string): PipelineCache;
}
//# sourceMappingURL=cache.d.ts.map