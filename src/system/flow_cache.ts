/**
 * The pipeline answer, computed in the background and never in a request
 * (#8978). It cost ~660 ms of the main thread per read. `warmFlow` fills every
 * kind of reader at boot; a read then answers the copy it finds at once, and a
 * stale copy is recomputed once, in slices: `flowSlices` yields between its
 * heavy reads and each slice runs on its own turn of the loop, so no turn holds
 * the thread for more than one read. Only a read that finds no copy at all
 * (the app was never warmed) computes inline. A copy depends on what the
 * reader may see, so the key is the kind of reader and whether they see dollars.
 */

import type { App } from "../app.ts";
import type { Reader } from "../actions/telemetry.ts";
import { flowSlices } from "./telemetry.ts";

/** How long a computed answer is served as fresh, ms. */
export const FLOW_TTL_MS = 5_000;

/** Runs `fn` on a later turn of the event loop; replaced in tests. */
export type Schedule = (fn: () => void) => void;
export interface FlowDeps {
  schedule: Schedule;
  log: (message: string, err: unknown) => void;
}

const defaults: FlowDeps = {
  schedule: (fn) => void setTimeout(fn, 0),
  log: (message, err) => console.error(message, err),
};

type Entry = { at: number; body: unknown; refreshing: boolean };
const cache = new WeakMap<App, Map<string, Entry>>();

const READERS: readonly Reader[] = [{ kind: "owner" }, { kind: "agent" }, { kind: "agent", spend: true }];
const keyOf = (r: Reader) => (r.kind === "owner" ? "owner" : r.spend ? "agent+spend" : "agent");

function entries(app: App): Map<string, Entry> {
  let byKey = cache.get(app);
  if (!byKey) cache.set(app, (byKey = new Map()));
  return byKey;
}

/** Computes one copy a slice per turn; `done` gets the body, or the error. */
function sliced(app: App, reader: Reader, at: number, deps: FlowDeps, done: (body: unknown) => void, failed: (e: unknown) => void): void {
  const g = flowSlices(app, reader, new Date(at));
  const step = () => {
    try {
      const r = g.next();
      if (r.done) done(r.value);
      else deps.schedule(step);
    } catch (e) {
      failed(e);
    }
  };
  deps.schedule(step);
}

function refresh(app: App, reader: Reader, hit: Entry, deps: FlowDeps, now: () => number): void {
  hit.refreshing = true;
  const at = now();
  sliced(
    app,
    reader,
    at,
    deps,
    (body) => {
      hit.body = body;
      hit.at = at;
      hit.refreshing = false;
    },
    (e) => {
      // keep the stale copy, say so, and let the next read try again
      deps.log(`flow cache: refresh for ${keyOf(reader)} failed; serving the stale copy`, e);
      hit.refreshing = false;
    },
  );
}

/** Fills the cache for every kind of reader without a request waiting; resolves when all are filled. */
export function warmFlow(app: App, deps: FlowDeps = defaults, now: () => number = Date.now): Promise<void> {
  const byKey = entries(app);
  return Promise.all(
    READERS.map(
      (reader) =>
        new Promise<void>((resolve) => {
          const at = now();
          sliced(
            app,
            reader,
            at,
            deps,
            (body) => {
              byKey.set(keyOf(reader), { at, body, refreshing: false });
              resolve();
            },
            (e) => {
              deps.log(`flow cache: warming ${keyOf(reader)} failed`, e);
              resolve();
            },
          );
        }),
    ),
  ).then(() => undefined);
}

/** A copy with the time it was computed (ms since epoch) — what a poller's validators come from. */
export function flowCopy(app: App, reader: Reader, now = Date.now(), deps: FlowDeps = defaults): { body: unknown; at: number } {
  const byKey = entries(app);
  const key = keyOf(reader);
  const hit = byKey.get(key);
  if (!hit) {
    // never warmed: the one case a request computes
    const g = flowSlices(app, reader, new Date(now));
    let r = g.next();
    while (!r.done) r = g.next();
    byKey.set(key, { at: now, body: r.value, refreshing: false });
    return { body: r.value, at: now };
  }
  if (now - hit.at >= FLOW_TTL_MS && !hit.refreshing) refresh(app, reader, hit, deps, () => now);
  return { body: hit.body, at: hit.at };
}

export function flowCached(app: App, reader: Reader, now = Date.now(), deps: FlowDeps = defaults): unknown {
  return flowCopy(app, reader, now, deps).body;
}

/** The validator for a copy: the kind of reader and when it was computed; the body is never hashed. */
export function flowEtag(reader: Reader, at: number): string {
  return `"flow-${keyOf(reader)}-${at}"`;
}

/** Whole seconds until a copy computed at `at` is FLOW_TTL_MS old, never below 0. */
export function flowMaxAge(at: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((at + FLOW_TTL_MS - now) / 1000));
}

/** Drops every copy for `app`, so the next read computes afresh; for a test that changed what flow reads. */
export function forgetFlow(app: App): void {
  cache.delete(app);
}
