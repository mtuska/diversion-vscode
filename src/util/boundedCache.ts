/**
 * Insertion-ordered cache with a hard cap. `get` refreshes recency (LRU); on
 * overflow the oldest entry is evicted.
 *
 * Values may be promises, in which case identical in-flight requests coalesce
 * into one — see `CoreApiClient.cached`.
 */
export class BoundedCache<V> {
  private readonly map = new Map<string, V>();
  constructor(private readonly cap: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
    return v;
  }

  set(key: string, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.cap) {
      const oldest = this.map.keys().next().value as string | undefined;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  has(key: string): boolean { return this.map.has(key); }
  delete(key: string): void { this.map.delete(key); }
  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
  values(): IterableIterator<V> { return this.map.values(); }
}
