/**
 * What keeps the lent model door from being spent past its cap or hammered
 * (#10484). The cap is checked before a call and counted after it, so calls
 * in flight at once would each pass the check: a child may have at most
 * `MAX_IN_FLIGHT` calls under way, and the spend can pass its cap by no more
 * than that many calls cost. Bad bearers are counted too: past
 * `BAD_PER_MINUTE` a minute, a bearer that does not check out is answered
 * "slow down" and nothing more (a good bearer is never turned away by them).
 * Process memory only; a restart empties it, and no call is then in flight.
 */

import type { App } from "../app.ts";

export const MAX_IN_FLIGHT = 4;
export const BAD_PER_MINUTE = 30;
const MINUTE = 60_000;

interface Guard {
  readonly inflight: Map<string, number>;
  bad: number[];
}

const guards = new WeakMap<App, Guard>();

function guardOf(app: App): Guard {
  let g = guards.get(app);
  if (g === undefined) {
    g = { inflight: new Map(), bad: [] };
    guards.set(app, g);
  }
  return g;
}

/** Take one place for `name`; the release (once only) gives it back. Undefined when all are taken. */
export function enter(app: App, name: string): (() => void) | undefined {
  const g = guardOf(app);
  const n = g.inflight.get(name) ?? 0;
  if (n >= MAX_IN_FLIGHT) return undefined;
  g.inflight.set(name, n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (g.inflight.get(name) ?? 1) - 1;
    if (left <= 0) g.inflight.delete(name);
    else g.inflight.set(name, left);
  };
}

/** A bearer that did not check out. True when there have been too many of these this minute. */
export function noteBad(app: App, now: number = Date.now()): boolean {
  const g = guardOf(app);
  g.bad = g.bad.filter((t) => now - t < MINUTE);
  if (g.bad.length < BAD_PER_MINUTE * 2) g.bad.push(now);
  return g.bad.length > BAD_PER_MINUTE;
}
