/**
 * A short memory of slow reads (git processes), per app and key. A read is
 * kept `TTL_MS`; asked again within it, the same promise answers, so a
 * reload, a second viewer or a loop of requests costs no further process.
 * A write that makes a read stale calls `forget`.
 */

import type { App } from "../app.ts";

export const TTL_MS = 5000;
const MAX_KEPT = 2000;
const kept = new WeakMap<App, Map<string, { at: number; value: Promise<unknown> }>>();

export function remembered<T>(app: App, key: string, make: () => Promise<T>): Promise<T> {
  let mine = kept.get(app);
  if (mine === undefined) kept.set(app, (mine = new Map()));
  const now = Date.now();
  const hit = mine.get(key);
  if (hit !== undefined && now - hit.at < TTL_MS) return hit.value as Promise<T>;
  if (mine.size >= MAX_KEPT) for (const [k, v] of mine) if (now - v.at >= TTL_MS) mine.delete(k);
  if (mine.size >= MAX_KEPT) mine.clear();
  const value = make();
  mine.set(key, { at: now, value });
  const own = mine;
  value.catch(() => own.get(key)?.value === value && own.delete(key));
  return value;
}

/** Drop what is kept for `app`: a pin, a note or a deletion has just changed it. */
export function forget(app: App): void {
  kept.get(app)?.clear();
}
