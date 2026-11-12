/**
 * Strangers' code pages wait in a line of their own (#9513).
 *
 * Under a flood of anonymous code pages (`bench/signed-in-under-load.ts`,
 * 500 a second) a signed-in `/` took 13–22 s at p95. The profile: the main
 * thread, not git. Every stranger's page was worked on at once, each a few
 * milliseconds of rendering, queries and compression; the event loop lagged
 * seconds behind, and git permits stayed held while their processes' output
 * waited to be read — so `gitGate` waits looked long, as a symptom.
 *
 * So an anonymous code page first takes a permit here — half the plumbing
 * pool, at least one (`FORGE_STRANGER_CODE_CONCURRENCY` overrides) — and,
 * holding it, gives the event loop one turn before its work: a permit handed
 * on is a microtask, and without that turn a queue of cached pages runs back
 * to back while no person's request is even read. A signed-in request never
 * touches this gate: it is never queued here and never refused here.
 *
 * The share is read from `gitGate.limit` on every request, so an admin who
 * resizes the git pool (`core/capacity.ts`) moves the strangers' share too.
 *
 * The line is bounded: with `STRANGER_CODE_QUEUE` strangers already waiting,
 * the next is told 503 with `Retry-After` rather than held in memory. The
 * check and the enqueue run in one synchronous step, so a burst cannot
 * overshoot the bound.
 */

import { Gate, gitGate } from "../git/env.ts";
import type { Handler } from "./context.ts";

/** How many anonymous code pages may be worked on at once, for a git pool of `gitLimit`. */
export function strangerShare(gitLimit: number, override: string | undefined = process.env.FORGE_STRANGER_CODE_CONCURRENCY): number {
  const fixed = Number(override);
  if (override !== undefined && override !== "" && Number.isFinite(fixed) && fixed >= 1) return Math.floor(fixed);
  return Math.max(1, Math.floor(gitLimit / 2));
}

/** How many anonymous code pages may wait for a permit before the next is refused. */
export const STRANGER_CODE_QUEUE = 256;

export const strangerCodeGate = new Gate(strangerShare(gitGate.limit));

export interface StrangerLine {
  readonly gate: Gate;
  /** The git pool whose share `gate` is kept at. */
  readonly pool: Gate;
  readonly queue: number;
}

const forge: StrangerLine = { gate: strangerCodeGate, pool: gitGate, queue: STRANGER_CODE_QUEUE };

/**
 * `handler` as it answers a code page: directly for a signed-in request,
 * behind the strangers' gate for anyone else.
 */
export function strangerCode(handler: Handler, line: StrangerLine = forge): Handler {
  return async (ctx) => {
    if (ctx.auth.user !== undefined) return handler(ctx);
    const share = strangerShare(line.pool.limit);
    if (line.gate.limit !== share) line.gate.resize(share);
    const { active, waiting, limit } = line.gate.stats();
    if (active >= limit && waiting >= line.queue) {
      return new Response("Busy reading code for others; retry in a second, or sign in.\n", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "1", "cache-control": "no-store" },
      });
    }
    return line.gate.run(async () => {
      // A permit handed on is a resolved promise, a microtask: without this
      // turn of the event loop a queue of strangers' cached pages runs back to
      // back and no new request — a person's — is even read until it drains.
      await new Promise<void>((resume) => setImmediate(resume));
      return handler(ctx);
    });
  };
}
