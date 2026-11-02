/**
 * The one-time pass over what the Later gate holds (#8700): the candidates
 * (`core/gate_triage.ts`) read for a repository, and applied on one approval.
 * Applying closes what the person ticked; what they left unticked stays
 * behind the gate. A closed issue keeps a "Gate review:" note and the
 * `issue.gate_reviewed` event only this path writes, which is how it is found
 * again and revived (`liftHold`). The approval carries a digest of the
 * candidates the person read; if the gate holds other issues now, the apply
 * refuses. A person approves — an agent may read the proposal and never
 * apply it.
 */

import { createHash } from "node:crypto";
import type { App } from "../app.ts";
import { alreadyDone } from "../core/done_on_main.ts";
import { heldIssues, REVIEW_NOTE } from "../core/gate_hold.ts";
import { startsTicked, triage, type Theme, type Triaged } from "../core/gate_triage.ts";
import { getIssue } from "../core/issues.ts";
import { pillarsOf } from "../core/pillars.ts";
import { canWrite, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { addComment, setIssueState } from "./issues.ts";

export interface GateReview {
  readonly themes: readonly Theme[];
  /** Every held issue as a candidate to close. */
  readonly changes: readonly Triaged[];
  /** The numbers that start ticked: what the crew found done on main. */
  readonly ticked: readonly number[];
  /** Names the candidates shown; the apply must carry it back. */
  readonly digest: string;
  readonly held: number;
}

/** A short name for a set of issue numbers, whatever their order. */
export function reviewDigest(numbers: readonly number[]): string {
  const sorted = [...numbers].sort((a, b) => a - b).join(",");
  return createHash("sha256").update(sorted).digest("hex").slice(0, 16);
}

/** How many open issues wait for each of these, in one read. */
function waitingOn(app: App, ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (ids.length === 0) return out;
  const rows = app.db
    .query<{ blocked_by_id: string; n: number }, string[]>(
      `SELECT d.blocked_by_id, COUNT(*) AS n FROM issue_dependency d
         JOIN issue ON issue.id = d.issue_id
        WHERE issue.state = 'open' AND d.blocked_by_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})
        GROUP BY d.blocked_by_id`,
    )
    .all(...ids);
  for (const r of rows) out.set(r.blocked_by_id, r.n);
  return out;
}

/** What the gate holds, triaged by title: one read. */
export function reviewGate(app: App, repo: Repo): GateReview | undefined {
  const set = pillarsOf(app.db, repo);
  if (set.gate === undefined) return undefined;
  const held = heldIssues(app.db, repo, set);
  const ids = held.map((i) => i.id);
  const done = alreadyDone(app.db, ids);
  const waiting = waitingOn(app, ids);
  const themes = triage(
    held.map((i) => ({ number: i.number, title: i.title, waiting: waiting.get(i.id) ?? 0 })),
    new Set(held.filter((i) => done.has(i.id)).map((i) => i.number)),
  );
  const changes = themes.flatMap((t) => t.items);
  return {
    themes,
    changes,
    ticked: changes.filter(startsTicked).map((c) => c.number),
    digest: reviewDigest(changes.map((c) => c.number)),
    held: held.length,
  };
}

export type ApplyError = "not_found" | "forbidden" | "stale";

/**
 * Apply the approval the person gave: `approved` are the issue numbers they
 * ticked and `digest` names the candidates they read. If the gate holds other
 * issues now, or an approved one is not a candidate, the whole is refused, so
 * a person never approves what they did not read. Returns how many closed.
 */
export function applyGateReview(
  app: App,
  actor: User,
  repo: Repo,
  approved: readonly number[],
  digest: string | undefined,
): Result<number, ApplyError> {
  if (actor.kind === "agent" || !canWrite(app.db, repo, actor)) return err("forbidden");
  const review = reviewGate(app, repo);
  if (review === undefined) return err("not_found");
  if (digest !== review.digest) return err("stale");
  const proposed = new Map(review.changes.map((c) => [c.number, c.verdict]));
  if (!approved.every((n) => proposed.has(n))) return err("stale");
  let closed = 0;
  for (const number of new Set(approved)) {
    const issue = getIssue(app.db, repo.id, number);
    const verdict = proposed.get(number)!;
    if (issue === undefined || issue.state !== "open") continue;
    if (!setIssueState(app, actor, repo, issue, "closed", { reason: verdict.reason }).ok) continue;
    // The marker follows the close, never the other way: a failed close leaves none.
    app.bus.append({
      kind: "issue.gate_reviewed",
      repoId: repo.id,
      actorId: actor.id,
      payload: { number: issue.number },
    });
    addComment(app, actor, repo, issue, `${REVIEW_NOTE}closed: ${verdict.why}. Revive it from the held page to bring it back.`);
    closed++;
  }
  return ok(closed);
}
