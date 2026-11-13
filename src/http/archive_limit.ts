/**
 * The archive route is open to strangers and each build is a `git archive`
 * plus a gzip in this process, so it is bounded twice: a source may start
 * `ARCHIVES_PER_MINUTE` builds a sliding minute (the source is the peer as
 * `http/peer.ts` resolves it from the socket, an IPv6 client by its /64,
 * never a header the client sets), and at most `ARCHIVES_AT_ONCE` run in the
 * forge together. A refusal is not counted. In memory, bounded by the
 * number of sources seen in a minute (pruned on every take).
 */

import { clientBucket } from "./peer.ts";

export const ARCHIVES_PER_MINUTE = 6;
export const ARCHIVES_AT_ONCE = 2;
/** Gzip bytes the HTTP route serves; a larger tree goes by git or `?path=`. */
export const ARCHIVE_HTTP_BYTES = 16 * 1024 * 1024;

const WINDOW_MS = 60_000;
const seen = new Map<string, number[]>();
let running = 0;

export type Take = { ok: true; done: () => void } | { ok: false; why: "rate" | "busy"; retryAfter: number };

/** Admit one build from `request`'s source, or say why not; call `done` when it ends. */
export function takeArchive(request: Request, now: number = Date.now()): Take {
  for (const [k, at] of seen) {
    const live = at.filter((t) => now - t < WINDOW_MS);
    if (live.length === 0) seen.delete(k);
    else seen.set(k, live);
  }
  const key = clientBucket(request);
  const mine = seen.get(key) ?? [];
  if (mine.length >= ARCHIVES_PER_MINUTE) return { ok: false, why: "rate", retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (now - mine[0]!)) / 1000)) };
  if (running >= ARCHIVES_AT_ONCE) return { ok: false, why: "busy", retryAfter: 5 };
  seen.set(key, [...mine, now]);
  running++;
  let ended = false;
  return {
    ok: true,
    done: () => {
      if (ended) return;
      ended = true;
      running--;
    },
  };
}

/** Test seam: forget every source and the count in flight. */
export function forgetArchives(): void {
  seen.clear();
  running = 0;
}
