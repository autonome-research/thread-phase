/**
 * Pipeline-scoped cache — shared across phases and tool calls within a single
 * pipeline run. Avoids redundant work when multiple phases (or multiple
 * parallel agents within a phase) read the same data.
 *
 * Created per-pipeline, cleared on completion.
 */

export class PipelineCache {
  private store = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.store.get(key) as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }

  /** Cache-or-fetch. */
  async getOrFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.store.has(key)) {
      return this.store.get(key) as T;
    }
    const value = await fetcher();
    this.store.set(key, value);
    return value;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
