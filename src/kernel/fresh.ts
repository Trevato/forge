/**
 * A value kept for a short while: the first caller makes it, everyone
 * after it inside `ttlMs` is handed the same one — a promise included, so
 * a burst of callers while it is being made waits on one piece of work
 * instead of starting its own. A promise that rejects is forgotten at
 * once, so a failure is never what the next caller is handed.
 *
 * For an answer anyone may ask for and nobody needs to the second (a
 * public card, a sitemap): what a crowd of strangers can make the forge
 * do is then one piece of work per key per `ttlMs`, however many ask.
 * Keys are bounded (`maxKeys`, the oldest dropped first), so a caller who
 * varies the key cannot grow the map.
 */
export class Fresh<T> {
  private readonly kept = new Map<string, { value: T; until: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxKeys = 16,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string, make: () => T): T {
    const at = this.now();
    const hit = this.kept.get(key);
    if (hit !== undefined && hit.until > at) return hit.value;
    this.kept.delete(key);
    const value = make();
    if (value instanceof Promise)
      value.catch(() => {
        if (this.kept.get(key)?.value === value) this.kept.delete(key);
      });
    this.kept.set(key, { value, until: at + this.ttlMs });
    while (this.kept.size > this.maxKeys) {
      const oldest = this.kept.keys().next().value;
      if (oldest === undefined) break;
      this.kept.delete(oldest);
    }
    return value;
  }

  /** Forget everything kept. */
  clear(): void {
    this.kept.clear();
  }
}
