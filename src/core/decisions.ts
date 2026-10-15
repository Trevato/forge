/**
 * The decision ledger. A fixed-choice decision — which issue next, ship or
 * show, try again or stop — is recorded with what the decider saw and what
 * it answered, and later with what came of it. The ledger is how the crew's
 * value function stops being a feeling: cost per shipped change, regrets,
 * and whether the decider beats the rule are all questions of this table.
 */

import type { Database } from "bun:sqlite";
import { id as newId } from "../kernel/id.ts";

/** `guard` is the crew's rule not starting a run it can see is waste —
 * a follow-up with nothing new (`skipped`), an issue at its run cap
 * (`capped`) — counted by `guardCounts` (`crew/guard.ts`).
 *
 * `lean` was which option on a studio ask card a careful owner would pick.
 * Nothing records one any more; older ledgers still hold rows of it, and the
 * summaries that read them keep the word. */
export type DecisionKind = "next" | "land" | "retry" | "lean" | "guard";

export interface Decision {
  readonly id: string;
  readonly kind: DecisionKind;
  readonly repoId: string;
  readonly issueId: string | null;
  /** What the decider saw, as it was sent. */
  readonly state: unknown;
  readonly answer: string;
  /** The decider's probability for its answer (1 for a rule). */
  readonly p: number;
  /** Who answered: the decider's name, or `rule`. */
  readonly by: string;
  readonly ms: number;
  readonly createdAt: string;
  /** What came of it, once known: `shipped`, `shown`, `green`, `red`, `closed`. */
  readonly outcome: string | null;
  readonly outcomeAt: string | null;
}

interface Row {
  id: string;
  kind: string;
  repo_id: string;
  issue_id: string | null;
  state: string;
  answer: string;
  p: number;
  by: string;
  ms: number;
  created_at: string;
  outcome: string | null;
  outcome_at: string | null;
}

function toDecision(r: Row): Decision {
  let state: unknown = r.state;
  try {
    state = JSON.parse(r.state);
  } catch {
    // Stored as text: kept as text.
  }
  return {
    id: r.id,
    kind: r.kind as DecisionKind,
    repoId: r.repo_id,
    issueId: r.issue_id,
    state,
    answer: r.answer,
    p: r.p,
    by: r.by,
    ms: r.ms,
    createdAt: r.created_at,
    outcome: r.outcome,
    outcomeAt: r.outcome_at,
  };
}

export interface RecordDecisionInput {
  readonly kind: DecisionKind;
  readonly repoId: string;
  readonly issueId?: string | undefined;
  readonly state: unknown;
  readonly answer: string;
  readonly p: number;
  readonly by: string;
  readonly ms: number;
}

export function recordDecision(
  db: Database,
  input: RecordDecisionInput,
): Decision {
  const id = newId();
  db.query(
    `INSERT INTO decision (id, kind, repo_id, issue_id, state, answer, p, by, ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  ).run(
    id,
    input.kind,
    input.repoId,
    input.issueId ?? null,
    typeof input.state === "string" ? input.state : JSON.stringify(input.state),
    input.answer,
    input.p,
    input.by,
    input.ms,
  );
  return getDecision(db, id)!;
}

export function getDecision(db: Database, id: string): Decision | undefined {
  const row = db
    .query<Row, [string]>("SELECT * FROM decision WHERE id = ?1")
    .get(id);
  return row ? toDecision(row) : undefined;
}

/** The newest decision of this kind about an issue, resolved or not. */
export function latestDecision(
  db: Database,
  issueId: string,
  kind: DecisionKind,
): Decision | undefined {
  const row = db
    .query<
      Row,
      [string, string]
    >("SELECT * FROM decision WHERE issue_id = ?1 AND kind = ?2 ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(issueId, kind);
  return row ? toDecision(row) : undefined;
}

/**
 * Whether a `retry` decision still stops its pull. The crew's stop is its
 * answer to a red check (the check is in what it saw), so a check that
 * passes afterwards — a re-run on the same head, or a newer head — is the
 * end of it: the ledger's `green` outcome, or a green verdict finished
 * after it was taken (`greenAt`). Any other stop is a person's, and only a
 * person lifts it.
 */
export function stopStands(
  decision: Decision | undefined,
  greenAt?: string | undefined,
): boolean {
  if (decision?.kind !== "retry" || decision.answer !== "stop") return false;
  const state = decision.state;
  const aboutACheck =
    typeof state === "object" && state !== null && "check" in state;
  if (!aboutACheck) return true;
  if (decision.outcome === "green") return false;
  return greenAt === undefined || greenAt <= decision.createdAt;
}

/** What came of the newest unresolved decision of this kind about an issue. */
export function resolveOpen(
  db: Database,
  issueId: string,
  kind: DecisionKind,
  outcome: string,
): boolean {
  const open = db
    .query<
      { id: string },
      [string, string]
    >("SELECT id FROM decision WHERE issue_id = ?1 AND kind = ?2 AND outcome IS NULL ORDER BY created_at DESC, id DESC LIMIT 1")
    .get(issueId, kind);
  if (!open) return false;
  db.query(
    `UPDATE decision SET outcome = ?2, outcome_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  ).run(open.id, outcome);
  return true;
}

export function listDecisions(
  db: Database,
  repoId: string,
  options: { kind?: DecisionKind | undefined; limit?: number | undefined } = {},
): Decision[] {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const rows =
    options.kind === undefined
      ? db
          .query<
            Row,
            [string, number]
          >("SELECT * FROM decision WHERE repo_id = ?1 ORDER BY created_at DESC, id DESC LIMIT ?2")
          .all(repoId, limit)
      : db
          .query<
            Row,
            [string, string, number]
          >("SELECT * FROM decision WHERE repo_id = ?1 AND kind = ?2 ORDER BY created_at DESC, id DESC LIMIT ?3")
          .all(repoId, options.kind, limit);
  return rows.map(toDecision);
}

/** The newest decisions across several repositories, newest first. */
export function listDecisionsForRepos(
  db: Database,
  repoIds: readonly string[],
  limit = 12,
): Decision[] {
  const unique = [...new Set(repoIds)].slice(0, 400);
  if (unique.length === 0) return [];
  return db
    .query<Row, (string | number)[]>(
      // A guard's skips and caps are counted, not shown one by one: they
      // would crowd out the decisions a person reads (`crew/guard.ts`).
      `SELECT * FROM decision
       WHERE repo_id IN (${unique.map((_, n) => `?${n + 1}`).join(",")})
         AND kind != 'guard'
       ORDER BY created_at DESC, id DESC LIMIT ?${unique.length + 1}`,
    )
    .all(...unique, Math.min(500, Math.max(1, limit)))
    .map(toDecision);
}

export interface DecisionStat {
  readonly kind: DecisionKind;
  readonly n: number;
  /** How many the decider answered (the rest fell to the rule). */
  readonly decided: number;
  readonly answers: Readonly<Record<string, number>>;
  readonly outcomes: Readonly<Record<string, number>>;
}

/** The ledger summed up per kind, for a repository, since a moment. */
export function decisionStats(
  db: Database,
  repoId: string,
  since: string,
): DecisionStat[] {
  const rows = db
    .query<
      {
        kind: string;
        answer: string;
        by: string;
        outcome: string | null;
        n: number;
      },
      [string, string]
    >(
      `SELECT kind, answer, by, outcome, COUNT(*) AS n FROM decision
       WHERE repo_id = ?1 AND created_at >= ?2 GROUP BY kind, answer, by, outcome`,
    )
    .all(repoId, since);
  const byKind = new Map<
    string,
    {
      n: number;
      decided: number;
      answers: Record<string, number>;
      outcomes: Record<string, number>;
    }
  >();
  for (const r of rows) {
    const k = byKind.get(r.kind) ?? {
      n: 0,
      decided: 0,
      answers: {},
      outcomes: {},
    };
    k.n += r.n;
    if (r.by !== "rule") k.decided += r.n;
    k.answers[r.answer] = (k.answers[r.answer] ?? 0) + r.n;
    if (r.outcome !== null)
      k.outcomes[r.outcome] = (k.outcomes[r.outcome] ?? 0) + r.n;
    byKind.set(r.kind, k);
  }
  return [...byKind.entries()].map(([kind, k]) => ({
    kind: kind as DecisionKind,
    ...k,
  }));
}

/** A decision whose outcome is known, newest outcome first, for these repositories. */
export function listDecidedIn(
  db: Database,
  repoIds: readonly string[],
  limit = 50,
): Decision[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map((_, n) => `?${n + 2}`).join(",");
  return db
    .query<Row, (string | number)[]>(
      `SELECT * FROM decision
       WHERE outcome IS NOT NULL AND kind != 'lean' AND repo_id IN (${marks})
       ORDER BY outcome_at DESC, id DESC LIMIT ?1`,
    )
    .all(limit, ...repoIds)
    .map(toDecision);
}

/** The decisions of one kind made since a moment, across every repository, newest first. */
export function decisionsSince(
  db: Database,
  kind: DecisionKind,
  since: string,
  limit = 500,
): Decision[] {
  return db
    .query<
      Row,
      [string, string, number]
    >("SELECT * FROM decision WHERE kind = ?1 AND created_at >= ?2 ORDER BY created_at DESC, id DESC LIMIT ?3")
    .all(kind, since, Math.min(500, Math.max(1, limit)))
    .map(toDecision);
}
