/**
 * Wave proposals: a plan kept for a person's nod (`actions/plan.ts`), read
 * and moved between its states. Plain rows in, plain data out; the
 * actions in `actions/proposals.ts` own who may move one.
 */

import type { Database } from "bun:sqlite";

export type ProposalState = "pending" | "later" | "approved" | "redirected";

export interface Proposal {
  readonly id: string;
  readonly repoId: string;
  readonly authorId: string;
  readonly title: string;
  readonly why: string;
  /** The plan's items as stored JSON; `parsePlan` checks them again before use. */
  readonly issues: unknown;
  readonly state: ProposalState;
  readonly createdAt: string;
}

interface Row {
  id: string;
  repo_id: string;
  author_id: string;
  title: string;
  why: string;
  issues: string;
  state: string;
  created_at: string;
}

const toProposal = (r: Row): Proposal => {
  let issues: unknown = [];
  try {
    issues = JSON.parse(r.issues);
  } catch {
    // A row we cannot read shows no issues and cannot be approved.
  }
  return {
    id: r.id,
    repoId: r.repo_id,
    authorId: r.author_id,
    title: r.title,
    why: r.why,
    issues,
    state: r.state as ProposalState,
    createdAt: r.created_at,
  };
};

export function getProposal(db: Database, id: string): Proposal | undefined {
  const row = db.query<Row, [string]>("SELECT * FROM plan_proposal WHERE id = ?1").get(id);
  return row ? toProposal(row) : undefined;
}

/** The proposals in `state` for these repositories, oldest first. */
export function proposalsFor(
  db: Database,
  repoIds: readonly string[],
  state: ProposalState,
): Proposal[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map((_, i) => `?${i + 2}`).join(",");
  return db
    .query<Row, string[]>(
      `SELECT * FROM plan_proposal WHERE state = ?1 AND repo_id IN (${marks})
       ORDER BY created_at, id`,
    )
    .all(state, ...repoIds)
    .map(toProposal);
}

/** The titles of a proposal's issues, for a card and a row. */
export function issueTitles(p: Proposal): string[] {
  return Array.isArray(p.issues)
    ? p.issues
        .map((i) => (i !== null && typeof i === "object" ? (i as { title?: unknown }).title : undefined))
        .filter((t): t is string => typeof t === "string")
    : [];
}

/** Move a proposal from one of `from` to `to`; false when it was not in one (someone moved it first). */
export function moveProposal(
  db: Database,
  id: string,
  from: readonly ProposalState[],
  to: ProposalState,
): boolean {
  const marks = from.map((_, i) => `?${i + 4}`).join(",");
  const done = db
    .query(
      `UPDATE plan_proposal SET state = ?1, decided_at = ?2
       WHERE id = ?3 AND state IN (${marks})`,
    )
    .run(to, new Date().toISOString(), id, ...from);
  return done.changes === 1;
}
