/**
 * A stamped memo: a value is served again only while the stamp it was
 * computed under is still the stamp now, and never past its max age.
 *
 * The stamp is the invalidation (docs/CACHING.md): the caller derives it
 * from write clocks (`core/write_clock.ts`), so a write that could change the
 * value changes the stamp, and the next read recomputes. The max age is a
 * backstop for what no write clock sees — the passage of time — and the
 * entry count bounds memory: least recently used goes first.
 *
 * Nothing here is truth (invariant 4): any entry may be dropped at any
 * moment, and the only cost is computing it again.
 */

export interface StampedOptions {
  readonly maxEntries: number;
  readonly maxAgeMs: number;
  /** Test seam: the clock entries age against. */
  readonly now?: () => number;
}

interface Entry<V> {
  readonly stamp: string;
  readonly value: V;
  readonly at: number;
}

export class Stamped<V> {
  /** Insertion order is the LRU order; a hit re-inserts at the end. */
  private readonly entries = new Map<string, Entry<V>>();
  private readonly options: StampedOptions;
  private readonly now: () => number;
  hits = 0;
  misses = 0;

  constructor(options: StampedOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** The value for `key` computed under `stamp`, computing it if there is none. */
  get(key: string, stamp: string, compute: () => V): V {
    const now = this.now();
    const entry = this.entries.get(key);
    if (
      entry !== undefined &&
      entry.stamp === stamp &&
      now - entry.at < this.options.maxAgeMs
    ) {
      this.entries.delete(key);
      this.entries.set(key, entry);
      this.hits++;
      return entry.value;
    }
    this.misses++;
    const value = compute();
    this.store(key, stamp, value, now);
    return value;
  }

  /** The entry for `key` as stored, however old: for a caller that serves stale while it refreshes. Counts nothing. */
  peek(key: string): { readonly stamp: string; readonly value: V; readonly at: number } | undefined {
    return this.entries.get(key);
  }

  /** Store `value` for `key` under `stamp`, computed now: what a refresh off the request path lands. */
  put(key: string, stamp: string, value: V): void {
    this.store(key, stamp, value, this.now());
  }

  private store(key: string, stamp: string, value: V, at: number): void {
    this.entries.delete(key);
    this.entries.set(key, { stamp, value, at });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
