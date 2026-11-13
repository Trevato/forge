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
 * `lean` was which option on a studio ask card a careful owner would pick;
 * it is now a person's like or dislike of one sibling among a deck's
 * variants (`recordVariantVote`). Older ledgers hold the earlier rows, and
 * the summaries that read them keep the word.
 *
 * `hand` is a person's tap on "Let the decider" on a hand-over card
 * (`crew/handover.ts`): its state is the curated context the decider saw.
 *
 * `place` is where an environment's awake interval runs, owned metal or
 * cloud (`core/placement_policy.ts`), recorded by the runtime as the meter
 * interval opens (`recordPlacement`): its answer is the placement, its state
 * the inputs, the reason and the body target. Like a guard it is counted,
 * not listed among the crew's decisions.
 */
export type DecisionKind =
  | "next"
  | "land"
  | "retry"
  | "lean"
  | "guard"
  | "hand"
  | "place";

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

/**
 * The placement policy's answer for one environment, by the rule: the
 * inputs it saw, its reason and where the body goes, so cost can tell later
 * which price applied and a person can tell why.
 */
export function recordPlacement(
  db: Database,
  input: {
    readonly repoId: string;
    readonly env: string;
    readonly where: "owned" | "cloud";
    readonly reason: string;
    readonly seen: unknown;
    readonly target: unknown;
  },
): Decision {
  return recordDecision(db, {
    kind: "place",
    repoId: input.repoId,
    state: { env: input.env, seen: input.seen, reason: input.reason, target: input.target },
    answer: input.where,
    p: 1,
    by: "rule",
    ms: 0,
  });
}

/** A person's like or dislike of one pull among its variant siblings; the newest replaces their earlier one. */
export function recordVariantVote(
  db: Database,
  input: {
    readonly repoId: string;
    readonly issueId: string;
    readonly group: string;
    readonly number: number;
    readonly answer: "like" | "dislike";
    readonly by: string;
    readonly reason?: string | undefined;
  },
): Decision {
  // One vote per person per pull: a later one replaces the earlier.
  db.query(
    "DELETE FROM decision WHERE kind = 'lean' AND issue_id = ?1 AND by = ?2",
  ).run(input.issueId, input.by);
  return recordDecision(db, {
    kind: "lean",
    repoId: input.repoId,
    issueId: input.issueId,
    state: {
      group: input.group,
      number: input.number,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    },
    answer: input.answer,
    p: 1,
    by: input.by,
    ms: 0,
  });
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

/** `latestDecision` for many issues at once, by issue: one query per chunk. */
export function latestDecisionsFor(
  db: Database,
  issueIds: readonly string[],
  kind: DecisionKind,
): Map<string, Decision> {
  const out = new Map<string, Decision>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const rows = db
      .query<Row, string[]>(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (PARTITION BY issue_id ORDER BY created_at DESC, id DESC) AS nth
           FROM decision
           WHERE kind = ?1 AND issue_id IN (${batch.map((_, n) => `?${n + 2}`).join(",")})
         ) WHERE nth = 1`,
      )
      .all(kind, ...batch);
    for (const row of rows) if (row.issue_id) out.set(row.issue_id, toDecision(row));
  }
  return out;
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

/** Say what came of one decision, by id. */
export function setOutcome(db: Database, id: string, outcome: string): void {
  db.query(
    `UPDATE decision SET outcome = ?2, outcome_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  ).run(id, outcome);
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
  options: {
    kind?: DecisionKind | undefined;
    limit?: number | undefined;
    /** The id of the last row of the page before: read what is older. */
    before?: string | undefined;
  } = {},
): Decision[] {
  const limit = Math.min(500, Math.max(1, options.limit ?? 100));
  const args: (string | number)[] = [repoId];
  let where = "repo_id = ?1";
  if (options.kind !== undefined) {
    args.push(options.kind);
    where += ` AND kind = ?${args.length}`;
  }
  if (options.before !== undefined) {
    args.push(options.before);
    where += ` AND (created_at, id) < (SELECT created_at, id FROM decision WHERE id = ?${args.length})`;
  }
  args.push(limit);
  return db
    .query<Row, (string | number)[]>(
      `SELECT * FROM decision WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?${args.length}`,
    )
    .all(...args)
    .map(toDecision);
}

export const DECISIONS_LIMIT_DEFAULT = 30;
export const DECISIONS_LIMIT_MAX = 100;

/** A `limit` as the decisions read takes it: a whole number 1 to 100, or undefined when bad. */
export function decisionsLimit(raw: string | null): number | undefined {
  if (raw === null) return DECISIONS_LIMIT_DEFAULT;
  const n = /^\d{1,4}$/.test(raw) ? Number(raw) : 0;
  return n >= 1 && n <= DECISIONS_LIMIT_MAX ? n : undefined;
}

/** Whether `cursor` names a decision of this repository (a `next_cursor` of a page before). */
export function decisionCursorValid(db: Database, repoId: string, cursor: string): boolean {
  return (
    /^[A-Za-z0-9_-]{1,64}$/.test(cursor) &&
    db.query("SELECT 1 FROM decision WHERE id = ?1 AND repo_id = ?2").get(cursor, repoId) !== null
  );
}

/** Rows read per batch, and batches per request, while hunting for visible ones. */
const BATCH = 100;
const BATCHES = 5;

/**
 * One page of the ledger, newest first, after `cursor`. `visible` runs before
 * the page is cut, so a hidden row never shortens a page; the read is bounded,
 * and past the bound the page may be short, its `next_cursor` the last row it
 * showed (or, when it showed none, the last row scanned).
 */
export function decisionsPage(
  db: Database,
  repoId: string,
  options: {
    kind?: DecisionKind | undefined;
    limit: number;
    cursor?: string | undefined;
    visible: (d: Decision) => boolean;
  },
): { decisions: Decision[]; next_cursor: string | null } {
  const found: Decision[] = [];
  let before = options.cursor;
  let scanned: string | undefined;
  let more = false;
  for (let n = 0; n < BATCHES && found.length <= options.limit; n++) {
    const batch = listDecisions(db, repoId, { kind: options.kind, limit: BATCH, before });
    for (const d of batch) if (options.visible(d)) found.push(d);
    if (batch.length > 0) scanned = batch[batch.length - 1]!.id;
    more = batch.length === BATCH;
    if (!more) break;
    before = scanned;
  }
  const page = found.slice(0, options.limit);
  // A cursor is the last row this reader was shown. Only a page that found
  // nothing for a whole bound resumes after a row it scanned (maybe hidden):
  // without that the read could not move past a long run of hidden rows.
  const shown = found[Math.min(found.length, options.limit) - 1];
  const next =
    found.length > options.limit
      ? shown!.id
      : more
        ? (shown?.id ?? scanned ?? null)
        : null;
  return { decisions: page, next_cursor: next };
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
      // A guard's skips and caps, and where each environment was placed,
      // are counted, not shown one by one: they would crowd out the
      // decisions a person reads (`crew/guard.ts`).
      `SELECT * FROM decision
       WHERE repo_id IN (${unique.map((_, n) => `?${n + 1}`).join(",")})
         AND kind NOT IN ('guard', 'place')
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

/** How many repositories make the newest-first walk of decided rows cheaper than their own rows. */
const WALK_FROM = 30;

/** A decision whose outcome is known, newest outcome first, for these repositories. */
export function listDecidedIn(
  db: Database,
  repoIds: readonly string[],
  limit = 50,
): Decision[] {
  if (repoIds.length === 0) return [];
  const marks = repoIds.map((_, n) => `?${n + 2}`).join(",");
  // Many repositories: walk the decided ones newest first and stop at the limit (0.4 ms), where reading the
  // repositories' own decisions and sorting them took 92 ms. A few: their own rows are fewer than the walk.
  const walk = repoIds.length > WALK_FROM ? "INDEXED BY decision_outcome_at" : "";
  return db
    .query<Row, (string | number)[]>(
      `SELECT * FROM decision ${walk}
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

/**
 * What the decider did with a person's cards, in three piles: `closed`
 * (a hand-over set aside), `deferred` (a pull the decider held back with a
 * `stop`, until its check passes) and `asked` (a hand-over it left with the
 * owner). A rule's `stop` is the crew's own, not the decider's.
 */
export const DECIDER_PILES = ["closed", "deferred", "asked"] as const;
export type DeciderPile = (typeof DECIDER_PILES)[number];

const PILE_WHERE: Record<DeciderPile, string> = {
  closed: "kind = 'hand' AND answer = 'set_aside' AND outcome = 'set_aside'",
  deferred: "kind = 'retry' AND answer = 'stop' AND by != 'rule'",
  asked: "kind = 'hand' AND answer = 'ask_owner'",
};

export function isDeciderPile(s: unknown): s is DeciderPile {
  return DECIDER_PILES.includes(s as DeciderPile);
}

const inRepos = (n: number, from: number) =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/** Repository ids, once each, in batches small enough for one query — no owner's count is cut short. */
function repoBatches(repoIds: readonly string[], size = 400): string[][] {
  const ids = [...new Set(repoIds)];
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

/** How many decisions fall in each pile since a moment, across these repositories. */
export function deciderCounts(
  db: Database,
  repoIds: readonly string[],
  since: string,
): Record<DeciderPile, number> {
  const out = { closed: 0, deferred: 0, asked: 0 };
  for (const ids of repoBatches(repoIds))
    for (const pile of DECIDER_PILES)
      out[pile] +=
        db
          .query<{ n: number }, string[]>(
            `SELECT COUNT(*) AS n FROM decision
             WHERE created_at >= ?1 AND (${PILE_WHERE[pile]}) AND repo_id IN (${inRepos(ids.length, 2)})`,
          )
          .get(since, ...ids)?.n ?? 0;
  return out;
}

/** What an empty pile says, for a person. */
export const PILE_EMPTY: Record<DeciderPile, string> = {
  closed: "The decider has closed nothing today.",
  deferred: "The decider has held nothing back today.",
  asked: "The decider has not asked you about anything today.",
};

/** The ledger rows behind one pile's count, newest first. */
export function listDeciderPile(
  db: Database,
  repoIds: readonly string[],
  pile: DeciderPile,
  since: string,
  limit = 200,
): Decision[] {
  const cap = Math.min(500, Math.max(1, limit));
  const rows: Decision[] = [];
  for (const ids of repoBatches(repoIds))
    rows.push(
      ...db
        .query<Row, (string | number)[]>(
          `SELECT * FROM decision
           WHERE created_at >= ?1 AND (${PILE_WHERE[pile]}) AND repo_id IN (${inRepos(ids.length, 3)})
           ORDER BY created_at DESC, id DESC LIMIT ?2`,
        )
        .all(since, cap, ...ids)
        .map(toDecision),
    );
  return rows
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1))
    .slice(0, cap);
}
