/**
 * When a copy of the forge last left the machine (#3701). Two things carry
 * one off it: the destination itself, when it is a bucket (the platform's
 * `S3_*`, or one sealed on the Backups page), and the off-box mirror. Home
 * read only the mirror, so a forge whose nightly lands in a bucket every
 * morning and has no second bucket read "never". A directory is on the
 * machine whatever volume it is on, and so is a bucket served from
 * loopback (a MinIO beside the forge).
 *
 * Reads two small files under the data directory; no network, no clock.
 */

import { lastMirror } from "./mirror.ts";
import { lastSnapshotOutcome, offBoxAtOf } from "./outcome.ts";
import type { Store } from "./store.ts";

/** The host of a bucket's `where` (`host[:port]/bucket`), lower-cased, without its port or brackets. */
function hostOf(where: string): string {
  const authority = where.split("/")[0]!.toLowerCase();
  if (authority.startsWith("[")) return authority.slice(1, authority.indexOf("]"));
  return authority.replace(/:\d+$/, "");
}

function loopback(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Does a snapshot that lands in this store leave the machine? A directory never does. */
export function isOffBox(store: Pick<Store, "where" | "dir">): boolean {
  return store.dir === undefined && !loopback(hostOf(store.where));
}

/**
 * The newest time a snapshot was known to be off the machine: the newest
 * the mirror holds, or the newest that landed in a destination that is a
 * bucket, whichever is later. Null when neither has.
 */
export function lastOffBox(dataDir: string): string | null {
  const times: string[] = [];
  const mirrored = lastMirror(dataDir)?.newestAt;
  if (mirrored !== undefined && Number.isFinite(Date.parse(mirrored))) times.push(mirrored);
  const kept = lastSnapshotOutcome(dataDir);
  const landed = offBoxAtOf(kept);
  if (landed !== undefined && Number.isFinite(Date.parse(landed))) times.push(landed);
  if (times.length === 0) return null;
  return times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a));
}

