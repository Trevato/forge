/**
 * The rules of a bet (#8713), as plain data in and out. A bet has an
 * appetite — a share of the week's builder time — and a fixed budget:
 * when the time spent reaches it the bet stops, with no extension. Builders
 * pick only from backed bets (plus the small-fixes lane); a scope that has
 * not moved for two days is a raised hand. The same state always gives the
 * same picks.
 */

/** Bets that run at once. */
export const MAX_BACKED = 5;
/** The share a planner-started bet gets, until the owner says otherwise. */
export const AUTO_SHARE = 10;
/** How long nothing backed lets the planner start its top bets. */
export const AUTO_AFTER_MS = 24 * 3600_000;
/** How many bets the planner may start by itself. */
export const AUTO_COUNT = 2;
/** A scope untouched this long is a raised hand. */
export const STILL_MS = 2 * 24 * 3600_000;
export const WEEK_S = 7 * 24 * 3600;

export interface Span {
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/** Seconds of builder time the runs took, an unfinished run counted up to `now`. */
export function spentSeconds(runs: readonly Span[], now: Date): number {
  let total = 0;
  for (const r of runs) {
    if (r.startedAt === null) continue;
    const from = Date.parse(r.startedAt);
    const to = r.finishedAt === null ? now.getTime() : Date.parse(r.finishedAt);
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) total += (to - from) / 1000;
  }
  return Math.round(total);
}

/** The builder seconds a share of the week buys with `slots` builders. */
export function budgetSeconds(appetite: number, slots: number): number {
  return Math.round((Math.max(0, Math.min(100, appetite)) / 100) * Math.max(0, slots) * WEEK_S);
}

/** Whether the bet has used its appetite. */
export function spentUp(spent: number, budget: number): boolean {
  return spent >= budget;
}

/** Whether backing `share` fits: fewer than 5 running and the shares within the whole week. */
export function mayBack(backed: readonly { readonly appetite: number }[], share: number): string | null {
  if (!Number.isInteger(share) || share < 1 || share > 100) return "a share of the week is a whole number from 1 to 100";
  if (backed.length >= MAX_BACKED) return `${MAX_BACKED} bets already run; end or cut one first`;
  if (backed.reduce((n, b) => n + b.appetite, 0) + share > 100) return "the shares would pass the whole week";
  return null;
}

export interface Proposed {
  readonly id: string;
  readonly proposedAt: string;
}

/**
 * The proposed bets the planner starts by itself: when nothing is backed and
 * the oldest proposal is a day old, the top few (oldest first, then id), each
 * for a modest share. Empty while anything runs, so one tap by the owner
 * always wins.
 */
export function autoStarts(proposed: readonly Proposed[], backedCount: number, now: Date): string[] {
  if (backedCount > 0 || proposed.length === 0) return [];
  const sorted = [...proposed].sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.id.localeCompare(b.id));
  if (now.getTime() - Date.parse(sorted[0]!.proposedAt) < AUTO_AFTER_MS) return [];
  return sorted.slice(0, AUTO_COUNT).map((p) => p.id);
}

export type ScopeState = "figuring out" | "executing" | "raised hand" | "done";

/** What a scope reads as: finished, quiet for too long, building, or still being worked out. */
export function scopeState(s: { closed: boolean; ran: boolean; movedAt: string }, now: Date): ScopeState {
  if (s.closed) return "done";
  if (now.getTime() - Date.parse(s.movedAt) >= STILL_MS) return "raised hand";
  return s.ran ? "executing" : "figuring out";
}

export interface Pickable {
  readonly raised: boolean;
  readonly small: boolean;
  /** The backed, running bet this issue is a scope of, or undefined. */
  readonly bet: string | undefined;
}

/**
 * Whether builders may pick an issue: one the owner raised or asked for; one
 * in a backed bet; a small fix (the small lane's cap holds it elsewhere). An
 * issue in no bet does not start by itself.
 */
export function mayPick(p: Pickable): boolean {
  return p.raised || p.small || p.bet !== undefined;
}
