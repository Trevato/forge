/**
 * The set /review draws and Home's "N waiting on you" counts: the asks
 * waiting on the viewer, split at 30 days into live and stale, and
 * nothing else: the forge's own needs stay where Home already shows them. One read, so the page, the line and the
 * MCP's `asks` cannot disagree.
 */

import type { Database } from "bun:sqlite";
import { listReposVisibleTo } from "../../core/repos.ts";
import type { User } from "../../core/users.ts";
import type { Ctx } from "../../http/context.ts";
import { waitingOn } from "./asks.ts";

/** An ask older than this many days is stale: out of the count, folded under one row. */
export const STALE_DAYS = 30;

type Ask = ReturnType<typeof waitingOn>[number];

export interface ReviewSet {
  /** Newest first. */
  readonly live: Ask[];
  /** Newest first. */
  readonly stale: Ask[];
  /** What the line says: the live asks. */
  readonly count: number;
}

/** Splits `asks` at `STALE_DAYS` before `now`, each side newest first. */
export function splitStale<T extends { since: string }>(asks: readonly T[], now: Date): { live: T[]; stale: T[] } {
  const cut = now.getTime() - STALE_DAYS * 86_400_000;
  const sorted = [...asks].sort((a, b) => Date.parse(b.since) - Date.parse(a.since));
  return {
    live: sorted.filter((a) => !(Date.parse(a.since) < cut)),
    stale: sorted.filter((a) => Date.parse(a.since) < cut),
  };
}

export function reviewSet(ctx: Ctx, user: User, now: Date = new Date()): ReviewSet {
  return reviewSetOf(ctx.app.db, user, now);
}

export function reviewSetOf(db: Database, user: User, now: Date): ReviewSet {
  const repos = listReposVisibleTo(db, user, { limit: 200, withoutArchived: true });
  const { live, stale } = splitStale(waitingOn(db, user, repos), now);
  return { live, stale, count: live.length };
}
