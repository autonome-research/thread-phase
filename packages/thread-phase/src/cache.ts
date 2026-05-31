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

export class PipelineCache {
  private readonly store: Map<string, unknown>;
  private readonly pending: Map<string, Promise<unknown>>;
  private readonly prefix: string;

  constructor(
    store?: Map<string, unknown>,
    prefix: string = '',
    pending?: Map<string, Promise<unknown>>,
  ) {
    this.store = store ?? new Map();
    this.pending = pending ?? new Map();
    this.prefix = prefix;
  }

  private k(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  get<T>(key: string): T | undefined {
    return this.store.get(this.k(key)) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(this.k(key), value);
  }

  has(key: string): boolean {
    return this.store.has(this.k(key));
  }

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
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const fullKey = this.k(key);
    if (this.store.has(fullKey)) {
      return this.store.get(fullKey) as T;
    }
    const inflight = this.pending.get(fullKey);
    if (inflight) {
      return inflight as Promise<T>;
    }
    const p = (async () => {
      try {
        const value = await fetcher();
        this.store.set(fullKey, value);
        return value;
      } finally {
        this.pending.delete(fullKey);
      }
    })();
    this.pending.set(fullKey, p);
    return p as Promise<T>;
  }

  /**
   * Clear cache entries.
   *
   * On the root cache: drops every entry.
   * On a namespaced sub-cache: drops only entries whose keys start with this
   * namespace's prefix; entries belonging to the root cache or other
   * namespaces are untouched.
   */
  clear(): void {
    if (!this.prefix) {
      this.store.clear();
      this.pending.clear();
      return;
    }
    for (const k of [...this.store.keys()]) {
      if (k.startsWith(this.prefix)) this.store.delete(k);
    }
    for (const k of [...this.pending.keys()]) {
      if (k.startsWith(this.prefix)) this.pending.delete(k);
    }
  }

  /**
   * Total entries in the underlying store, across all namespaces. This is
   * shared state; a sub-cache reports the same number as the root.
   */
  get size(): number {
    return this.store.size;
  }

  /**
   * Return a sub-cache that prefixes all keys with `${name}:`. Sub-caches
   * are cheap (no copy) and share the underlying store.
   *
   * Nesting is supported: `cache.namespace('a').namespace('b')` prefixes
   * with `a:b:`. Empty names are rejected.
   */
  namespace(name: string): PipelineCache {
    if (!name) throw new Error('PipelineCache.namespace: name must be non-empty');
    return new PipelineCache(this.store, `${this.prefix}${name}:`, this.pending);
  }
}
