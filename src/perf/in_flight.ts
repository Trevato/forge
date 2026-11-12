/**
 * The requests the forge is answering right now (#11478): each one's start,
 * so a loop stall can name the request still running when the wake comes,
 * not only the ones that finished across it (`loop.ts`).
 *
 * One `Map` entry per open request, keyed by the request itself: `begin` and
 * `end` are a `set` and a `delete`, O(1), and the map holds only what is
 * open — it never grows with the requests already answered. The pattern is
 * read only at a wake (`nameOf`), since the router names a request after it
 * starts; a stall is rare, so the walk over the open set costs nothing on
 * the common request.
 */

export interface InFlight<K> {
  /** `key` started at `at` (`performance.now`). */
  begin(key: K, at: number): void;
  /** `key` is answered; a key never begun is ignored. */
  end(key: K): void;
  /** Run `work` with `key` open from `at` until it settles, however it settles. */
  during<T>(key: K, at: number, work: () => Promise<T>): Promise<T>;
  /** The patterns of the requests begun at or before `from` and still open, oldest first, each once. */
  since(from: number): string[];
  /** How many are open now. */
  size(): number;
}

export function createInFlight<K>(nameOf: (key: K) => string): InFlight<K> {
  const open = new Map<K, number>();
  return {
    begin(key, at) {
      open.set(key, at);
    },
    end(key) {
      open.delete(key);
    },
    async during(key, at, work) {
      open.set(key, at);
      try {
        return await work();
      } finally {
        open.delete(key);
      }
    },
    since(from) {
      const old: [number, string][] = [];
      for (const [key, at] of open) if (at <= from) old.push([at, nameOf(key)]);
      return [...new Set(old.sort((a, b) => a[0] - b[0]).map(([, name]) => name))];
    },
    size: () => open.size,
  };
}
