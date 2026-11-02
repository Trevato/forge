/**
 * Who acts next on an open pull, and why, in one line (#6350). `nextActor`
 * is plain data in, plain data out; `nextOfPull` reads the data for one pull
 * and the pull page and the MCP `pull` both answer from it.
 */

import type { Database } from "bun:sqlite";
import { getHold } from "../core/holds.ts";
import type { Pull } from "../core/pulls.ts";
import { latestProofRun } from "../core/proof_runs.ts";
import { checkSummary, type RunState } from "../core/runs.ts";
import { reviewSummary } from "../core/reviews.ts";
import { wallAsk, wallWords } from "./wall_wait.ts";

export type Actor = "builder" | "reviewer" | "queue" | "person";

export interface Next {
  readonly who: Actor;
  readonly why: string;
}

export interface NextInput {
  /** Who holds the pull and why; a hold keeps every rule off it. */
  readonly held: { readonly by: string; readonly why: string } | null;
  readonly conflicted: boolean;
  readonly check: RunState | "none";
  /** Reviewers whose current verdict, on this head, asks for changes / approves. */
  readonly changesRequested: number;
  readonly approvals: number;
  /** Verdicts passed on an older head: the pull was pushed to since. */
  readonly pushedSince: number;
  /** What the pull's proof on this head is doing when it is not green (#7706): "waits: no check slot is spare". */
  readonly proof?: string | null;
  /** What the access wall holds this head for, in plain words (#7847): a person decides it. */
  readonly wall?: readonly string[] | null;
}

const WAITING = {
  none: "waiting for its check",
  queued: "its check is queued",
  running: "its check is running",
  cancelled: "its check was cancelled",
} as const;

export function nextActor(i: NextInput): Next {
  if (i.held !== null)
    return { who: "person", why: `${i.held.by} holds it: ${i.held.why}` };
  if (i.conflicted) return { who: "builder", why: "it conflicts with its base" };
  if (i.changesRequested > 0)
    return { who: "builder", why: "changes were asked on this head" };
  if (i.check === "failed") return { who: "builder", why: "its check is red" };
  if (i.wall != null && i.wall.length > 0) return { who: "person", why: wallAsk(i.wall) };
  if (i.approvals > 0) {
    if (i.check === "ok" && i.proof) return { who: "queue", why: `approved and green, but its proof ${i.proof}` };
    if (i.check === "ok") return { who: "queue", why: "approved and green" };
    return { who: "queue", why: `approved, ${WAITING[i.check]}` };
  }
  return {
    who: "reviewer",
    why: i.pushedSince > 0 ? "pushed since the last review" : "no review yet",
  };
}

/** What the pull's proof on `head` is doing, in words; null when it is green or has not been tried. */
export function proofWords(db: Database, pull: Pull, head: string): string | null {
  const run = latestProofRun(db, pull.id);
  if (run === undefined || run.commitOid !== head) return null;
  switch (run.state) {
    case "queued":
      return `waits: ${run.summary}`;
    case "running":
      return "is running";
    case "failed":
      return run.summary === "red" ? "is red" : run.summary;
    case "cancelled":
      return `was ${run.summary}; it is proved again on the next sweep`;
    default:
      return null;
  }
}

/** The next actor of an open pull at `headOid`; null once it is merged or closed. */
export function nextOfPull(
  db: Database,
  pull: Pull,
  live: { readonly headOid: string; readonly conflicts: number },
): Next | null {
  if (pull.state !== "open" || pull.mergedAt !== null) return null;
  const reviews = reviewSummary(db, pull.id, live.headOid);
  const hold = getHold(db, pull.id);
  return nextActor({
    held: hold === undefined ? null : { by: hold.heldByName, why: hold.why },
    conflicted: live.conflicts > 0,
    check: checkSummary(db, pull.id, live.headOid).state,
    changesRequested: reviews.changesRequested,
    approvals: reviews.approvals,
    pushedSince: reviews.stale,
    proof: proofWords(db, pull, live.headOid),
    wall: wallWords(db, pull.id, live.headOid),
  });
}
