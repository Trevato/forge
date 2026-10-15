/**
 * What the forge says about itself to whatever keeps it running. Two
 * questions, two paths, because a probe that confuses them restarts a busy
 * forge and makes the busy moment worse (#1221):
 *
 * - `/healthz` — alive. 200 whenever the process answers and its database
 *   opens, however slow the moment; the only 503 is a database that will
 *   not answer at all. The liveness probe asks this, and a restart is its
 *   only remedy, so it says no only when a restart could help.
 * - `/readyz` — ready. 503 once the forge is draining — a release's old
 *   process, finishing what it holds while the new one takes everything
 *   new. The readiness probe asks this; it routes, it never restarts.
 *
 * Every deliberate 503 is said in the log, once, at the moment it starts.
 */

import type { Log } from "../kernel/log.ts";

export const health = { draining: false };

/** Whether the last liveness answer was a 503, so the log says so once. */
let databaseDown = false;

/**
 * Stop being ready, and say why in one line. Idempotent: a second signal
 * during a drain says nothing new.
 */
export function startDraining(log: Log, why: string, fields: Record<string, number> = {}): void {
  if (health.draining) return;
  health.draining = true;
  log.info("forge draining: /readyz answers 503 from now", { why, ...fields });
}

/**
 * Liveness: `ping` runs one trivial query against the database. However
 * long it takes, an answer is 200; only a throw is 503, logged when it
 * starts and when it ends.
 */
export function liveResponse(ping: () => unknown, log: Log): Response {
  try {
    ping();
  } catch (error) {
    if (!databaseDown)
      log.error("forge not alive: /healthz answers 503, the database does not answer", {
        error: error instanceof Error ? error.message : String(error),
      });
    databaseDown = true;
    return new Response("database", { status: 503 });
  }
  if (databaseDown) log.info("forge alive again: the database answers");
  databaseDown = false;
  return new Response("ok", { status: 200 });
}

/**
 * How long a draining forge keeps its listener open after SIGTERM, however
 * little it holds (#873). The platform takes the old process out of rotation
 * at the same time it signals it, but routers hear of that a beat later: a
 * readiness period (5 s in the chart), plus however long the ingress takes
 * to reload. A forge that exits in milliseconds refuses whatever arrives in
 * that beat, and the ingress turns each refusal into a 502. Ten seconds
 * covers the beat; the chart's grace period (300 s) covers the linger.
 */
export const DRAIN_LINGER_DEFAULT_S = 10;
export const DRAIN_LINGER_MAX_S = 120;

/**
 * `FORGE_DRAIN_LINGER_S` as milliseconds: whole seconds, 0 to
 * {@link DRAIN_LINGER_MAX_S}. Unset is the default; anything else that is
 * not such a number is null, so the boot says so instead of guessing.
 */
export function drainLingerMs(raw: string | undefined): number | null {
  const text = (raw ?? "").trim();
  if (text === "") return DRAIN_LINGER_DEFAULT_S * 1000;
  if (!/^\d{1,3}$/.test(text)) return null;
  const seconds = Number(text);
  return seconds <= DRAIN_LINGER_MAX_S ? seconds * 1000 : null;
}

/** Readiness: 200 while the forge takes new work, 503 once it drains. */
export function readyResponse(): Response {
  return health.draining
    ? new Response("draining", { status: 503 })
    : new Response("ok", { status: 200 });
}
