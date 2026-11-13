/**
 * Runs the crew can already see are waste (#807). Two rules, both asked
 * before a run is queued, neither a model call:
 *
 * - A follow-up with nothing new (`news.ts`) is skipped: the agent would
 *   read its own reply as the newest word and decline, at full price. So
 *   is the clock giving the planner the direction again when nobody spoke
 *   and the map has not moved since its last pass.
 * - An issue that has started `issueRunCap` runs inside a day since a
 *   person who may direct the crew last spoke is capped: parked with one
 *   note, raised as one ask, and given nothing more until that person
 *   speaks. A loop is a question, not a retry. The direction issue is not
 *   one issue retried but the planner's standing one: it has no cap, only
 *   the budget, the breaker and the nothing-new skip above.
 *
 * Each skip and each cap is a row in the decision ledger (kind `guard`,
 * by `rule`), so what the guard saved can be counted (`guardCounts`).
 */

import type { Database } from "bun:sqlite";
import type { Agent } from "../core/agents.ts";
import { recordDecision } from "../core/decisions.ts";
import type { Issue } from "../core/issues.ts";
import { listPulls } from "../core/pulls.ts";
import type { Repo } from "../core/repos.ts";
import { directorsAmong } from "./direct.ts";
import { nothingNew, plannerNothingNew } from "./news.ts";

/** Runs one issue may start in `CAP_WINDOW_MS` unless the setting says otherwise. */
export const ISSUE_RUN_CAP = 6;
export const CAP_WINDOW_MS = 24 * 60 * 60_000;
/** The run cap that applies to `issue`: the issue cap; the direction has none, the budget bounds the planner. */
export function runCapOf(
  repo: Repo,
  issue: Issue,
  caps: { readonly issueRunCap?: number },
): number {
  return issue.id === repo.directionIssueId
    ? Number.POSITIVE_INFINITY
    : (caps.issueRunCap ?? ISSUE_RUN_CAP);
}

/** The note a capped issue is parked with: the map reads it as `parked`, the asks as a question. */
export const CAP_NOTE =
  "Parked by the crew: this issue started its day's share of runs without landing, so nothing more starts here until a person says what to try.";

/** What a skipped follow-up records, and what its run says when one was already queued. */
export const SKIP_SUMMARY = "skipped: nothing new to act on since the last run";

/**
 * What the second follow-up on a verdict carries as its summary while it
 * waits: the run that asks again because the last try pushed nothing
 * (`requested.ts`). It is never skipped for having nothing new.
 */
export const RETRY_SUMMARY = "retry: the last follow-up ended without a push";

/** A follow-up for `agent` on `issue` that would find nothing new: skip it. */
export function skipsFeedback(
  db: Database,
  repo: Repo,
  issue: Issue,
  agent: Agent,
): boolean {
  if (!nothingNew(db, repo, issue, agent)) return false;
  recordDecision(db, {
    kind: "guard",
    repoId: repo.id,
    issueId: issue.id,
    state: { reason: "feedback", agent: agent.user.username },
    answer: "skipped",
    p: 1,
    by: "rule",
    ms: 0,
  });
  return true;
}

/**
 * The clock giving `planner` the direction again with nothing new since its
 * last pass (`plannerNothingNew`): skip it. The clock asks every minute, so
 * one skip is recorded per pass, the first time it is asked after `since`.
 */
export function skipsReplan(
  db: Database,
  repo: Repo,
  direction: Issue,
  planner: Agent,
  since: string,
): boolean {
  if (!plannerNothingNew(db, repo, direction, planner)) return false;
  const recorded = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM decision
        WHERE issue_id = ?1 AND kind = 'guard' AND answer = 'skipped'
          AND state LIKE '%"reason":"replan"%' AND created_at > ?2`,
    )
    .get(direction.id, since);
  if ((recorded?.n ?? 0) === 0)
    recordDecision(db, {
      kind: "guard",
      repoId: repo.id,
      issueId: direction.id,
      state: { reason: "replan", agent: planner.user.username },
      answer: "skipped",
      p: 1,
      by: "rule",
      ms: 0,
    });
  return true;
}

/**
 * Where the cap's count starts on `issue`: a day ago, or the last word of a
 * person who may direct the crew if that is later. The park note itself is
 * no one's word, whoever's name it carries.
 */
function capFrom(db: Database, repo: Repo, issue: Issue, now: Date): string {
  const from = new Date(now.getTime() - CAP_WINDOW_MS).toISOString();
  const spoke = db
    .query<{ id: string; at: string }, [string, string]>(
      `SELECT author_id AS id, MAX(created_at) AS at FROM comment
        WHERE issue_id = ?1 AND created_at > ?2 AND origin_author IS NULL
          AND body NOT LIKE 'Parked by the crew%'
        GROUP BY author_id`,
    )
    .all(issue.id, from);
  const directors = new Set(
    directorsAmong(
      db,
      repo,
      spoke.map((s) => s.id),
    ),
  );
  return spoke
    .filter((s) => directors.has(s.id))
    .map((s) => s.at)
    .reduce((a, b) => (a > b ? a : b), from);
}

/**
 * Whether `issue` has started `cap` runs inside the window since a person
 * who may direct the crew last spoke on it. A run a restart or the
 * provider cut short, a resumed run and a skipped one are not new starts;
 * nor is a reviewer's run on a pull, which only answers a push the counted
 * runs made and is bounded by the hand-over (`HANDOVER_ROUNDS`). Nor is a
 * run bringing a pull up to a main that moved, or answering its red check:
 * neither is the agent going round, and both already have their own bound
 * (`CHECK_FAILED_LIMIT` over `automaticRunsSince`), which parks or releases
 * the pull itself — counted here too, they parked pulls that were working.
 */
export function capReached(
  db: Database,
  repo: Repo,
  issue: Issue,
  cap: number,
  now = new Date(),
): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM run
        WHERE issue_id = ?1 AND kind = 'agent' AND created_at > ?2
          AND attempt = 0
          AND reason NOT IN ('review', 'conflict', 'check_failed')
          AND summary NOT LIKE 'interrupted: %'
          AND summary NOT LIKE 'skipped: %'`,
    )
    .get(issue.id, capFrom(db, repo, issue, now));
  return (row?.n ?? 0) >= cap;
}

/**
 * Whether `issue` already carries the cap's note inside the cap's window:
 * parked, and asked about, once. Words after the note — a review, a reader —
 * do not make it a second park; only a director's word starts a new window.
 */
export function capNoted(
  db: Database,
  repo: Repo,
  issue: Issue,
  now = new Date(),
): boolean {
  return (
    db
      .query<{ id: string }, [string, string, string]>(
        `SELECT id FROM comment
          WHERE issue_id = ?1 AND body = ?2 AND created_at >= ?3 LIMIT 1`,
      )
      .get(issue.id, CAP_NOTE, capFrom(db, repo, issue, now)) !== null
  );
}

/**
 * Record that `issue` was capped: at most once per cap window, however
 * often the clock asks again. Returns whether a decision was written.
 */
export function recordCap(
  db: Database,
  repo: Repo,
  issue: Issue,
  cap: number,
  now = new Date(),
): boolean {
  const seen = db
    .query<{ id: string }, [string, string]>(
      `SELECT id FROM decision
        WHERE issue_id = ?1 AND kind = 'guard' AND answer = 'capped'
          AND created_at >= ?2 LIMIT 1`,
    )
    .get(issue.id, capFrom(db, repo, issue, now));
  if (seen !== null) return false;
  recordDecision(db, {
    kind: "guard",
    repoId: repo.id,
    issueId: issue.id,
    state: { cap, windowHours: CAP_WINDOW_MS / 3_600_000 },
    answer: "capped",
    p: 1,
    by: "rule",
    ms: 0,
  });
  return true;
}

export interface GuardCounts {
  /** Follow-ups not started: nothing new to act on. */
  readonly skipped: number;
  /** Issues parked at their run cap. */
  readonly capped: number;
}

/** What the guard did on a repository since `since`: the token-return view's numbers. */
export function guardCounts(
  db: Database,
  repoId: string,
  since: string,
): GuardCounts {
  const rows = db
    .query<{ answer: string; n: number }, [string, string]>(
      `SELECT answer, COUNT(*) AS n FROM decision
        WHERE repo_id = ?1 AND kind = 'guard' AND created_at >= ?2
        GROUP BY answer`,
    )
    .all(repoId, since);
  const of = (answer: string): number =>
    rows.find((r) => r.answer === answer)?.n ?? 0;
  return { skipped: of("skipped"), capped: of("capped") };
}

/** Crew `changes_requested` verdicts on one pull, with no approval or person's word between, before it is a person's. */
export const HANDOVER_ROUNDS = 3;

/** What the hand-over card starts with: the thread's own record of it, and what `handover` ignores as a person's word. */
export const HANDOVER_NOTE = "Handed to a person by the crew:";

/**
 * Why a pass handed this pull to a person, in one line: the newest hand-over
 * note the assignee's own name carries (the finishing pass posts as them;
 * a reader's copy of the prefix is not the crew's word), without its prefix or the forge's "posted under your name"
 * aside. Undefined when no pass has handed it over.
 */
export function passReasonOf(db: Database, pullId: string, assigneeId: string): string | undefined {
  const row = db
    .query<{ body: string }, [string, string, string]>(
      "SELECT body FROM comment WHERE issue_id = ?1 AND body LIKE ?2 AND author_id = ?3 ORDER BY created_at DESC, id DESC LIMIT 1",
    )
    .get(pullId, `${HANDOVER_NOTE}%`, assigneeId);
  if (row === null) return undefined;
  const words = row.body
    .slice(HANDOVER_NOTE.length)
    .split(" (The forge posts")[0]!
    .replace(/\s+/g, " ")
    .trim();
  return words.length > 200 ? `${words.slice(0, 199)}…` : words;
}

export interface Handover {
  /** The crew reviewer's verdicts that asked for changes, oldest first. */
  readonly reviews: readonly {
    id: string;
    author: string;
    body: string;
    at: string;
    /** The line comments posted with it, oldest first. */
    lines?: readonly { path: string; line: number; body: string }[];
  }[];
  /** When the third one landed: the card's age. */
  readonly at: string;
}

/**
 * Whether `pullId` has had `HANDOVER_ROUNDS` crew `changes_requested` verdicts
 * since the last approval or the last word of a person who may direct the
 * crew. Counted from the verdict rows, never the runs: a run a restart
 * repeats is one verdict.
 */
export function handoverOf(
  db: Database,
  repo: Repo,
  pullId: string,
): Handover | undefined {
  // The common pull has fewer than three crew verdicts: one cheap count
  // answers it before the approval, comment and director lookups.
  const crewAsked = db
    .query<{ n: number }, [string, string]>(
      `SELECT COUNT(*) AS n FROM review r
         JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = ?2
        WHERE r.issue_id = ?1 AND r.state = 'changes_requested' AND c.role = 'reviewer'`,
    )
    .get(pullId, repo.id)!.n;
  if (crewAsked < HANDOVER_ROUNDS) return undefined;
  return handoversSince(db, [{ id: pullId, repo }]).get(pullId);
}

/** Pulls `handoversOf` counts per query: well under SQLite's bound on variables. */
const HANDOVER_CHUNK = 500;

/**
 * `handoverOf` for many pulls at once: the cheap count is one grouped query
 * per chunk, and only a pull with `HANDOVER_ROUNDS` crew verdicts — the rare
 * one — reads further. Only handed-over pulls get an entry.
 */
export function handoversOf(
  db: Database,
  pulls: readonly { readonly id: string; readonly repo: Repo }[],
): Map<string, Handover> {
  const out = new Map<string, Handover>();
  const repoOf = new Map(pulls.map((p) => [p.id, p.repo]));
  const ids = [...repoOf.keys()];
  for (let i = 0; i < ids.length; i += HANDOVER_CHUNK) {
    const chunk = ids.slice(i, i + HANDOVER_CHUNK);
    const rows = db
      .query<{ issueId: string; n: number }, string[]>(
        `SELECT r.issue_id AS issueId, COUNT(*) AS n FROM review r
           JOIN issue i ON i.id = r.issue_id
           JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = i.repo_id
          WHERE r.issue_id IN (${chunk.map((_, n) => `?${n + 1}`).join(",")})
            AND r.state = 'changes_requested' AND c.role = 'reviewer'
          GROUP BY r.issue_id`,
      )
      .all(...chunk);
    const enough = rows
      .filter((row) => row.n >= HANDOVER_ROUNDS)
      .map((row) => ({ id: row.issueId, repo: repoOf.get(row.issueId)! }));
    for (const [id, over] of handoversSince(db, enough)) out.set(id, over);
  }
  return out;
}

/**
 * The hand-overs of pulls that have had enough crew verdicts to have one,
 * by pull: the approvals, the people's words and the crew's rounds are one
 * query each for the set, and who may direct the crew is asked once per
 * repository for everyone who spoke there.
 */
function handoversSince(
  db: Database,
  pulls: readonly { readonly id: string; readonly repo: Repo }[],
): Map<string, Handover> {
  const out = new Map<string, Handover>();
  if (pulls.length === 0) return out;
  const ids = pulls.map((p) => p.id);
  const marks = ids.map((_, n) => `?${n + 2}`).join(",");
  const approved = new Map(
    db
      .query<{ issueId: string; at: string }, string[]>(
        `SELECT issue_id AS issueId, MAX(created_at) AS at FROM review
          WHERE issue_id IN (${ids.map((_, n) => `?${n + 1}`).join(",")}) AND state = 'approved'
          GROUP BY issue_id`,
      )
      .all(...ids)
      .map((r) => [r.issueId, r.at]),
  );
  const spoke = db
    .query<{ issueId: string; id: string; at: string }, string[]>(
      `SELECT issue_id AS issueId, author_id AS id, MAX(created_at) AS at FROM comment
        WHERE issue_id IN (${marks}) AND origin_author IS NULL AND kind != 'review'
          AND body NOT LIKE ?1
        GROUP BY issue_id, author_id`,
    )
    .all(`${HANDOVER_NOTE}%`, ...ids);
  const byRepo = new Map<string, { repo: Repo; ids: Set<string> }>();
  const repoOf = new Map(pulls.map((p) => [p.id, p.repo]));
  for (const s of spoke) {
    const repo = repoOf.get(s.issueId)!;
    const entry = byRepo.get(repo.id) ?? { repo, ids: new Set<string>() };
    entry.ids.add(s.id);
    byRepo.set(repo.id, entry);
  }
  const directors = new Map(
    [...byRepo].map(([repoId, { repo, ids }]) => [repoId, new Set(directorsAmong(db, repo, ids))]),
  );
  const since = new Map(ids.map((id) => [id, approved.get(id) ?? ""]));
  for (const s of spoke)
    if (directors.get(repoOf.get(s.issueId)!.id)?.has(s.id) && s.at > since.get(s.issueId)!)
      since.set(s.issueId, s.at);
  const rounds = new Map<string, { id: string; author: string; body: string; at: string }[]>();
  for (const r of db
    .query<{ issueId: string; id: string; author: string; body: string; at: string }, string[]>(
      `SELECT r.issue_id AS issueId, r.id AS id, u.username AS author, r.body AS body, r.created_at AS at
         FROM review r JOIN user u ON u.id = r.author_id
         JOIN issue i ON i.id = r.issue_id
         JOIN repo_crew c ON c.user_id = r.author_id AND c.repo_id = i.repo_id
        WHERE r.issue_id IN (${ids.map((_, n) => `?${n + 1}`).join(",")})
          AND r.state = 'changes_requested' AND c.role = 'reviewer'
        ORDER BY r.created_at, r.id`,
    )
    .all(...ids)) {
    if (r.at <= since.get(r.issueId)!) continue;
    const { issueId, ...round } = r;
    const list = rounds.get(issueId);
    if (list) list.push(round);
    else rounds.set(issueId, [round]);
  }
  const handed = [...rounds].filter(([, list]) => list.length >= HANDOVER_ROUNDS);
  const lines = linesOf(db, handed.map(([id]) => id));
  for (const [id, list] of handed)
    out.set(id, {
      reviews: withLines(lines.get(id) ?? [], list.slice(0, HANDOVER_ROUNDS), since.get(id)!),
      at: list[HANDOVER_ROUNDS - 1]!.at,
    });
  return out;
}

/**
 * Each review with the line comments its author posted just before it: lines
 * go in ahead of the verdict, so a review owns its author's lines since that
 * author's previous review (or since the thread was last reset).
 */
function withLines(
  rows: readonly LineRow[],
  reviews: readonly Handover["reviews"][number][],
  since: string,
): Handover["reviews"] {
  const last = new Map<string, string>();
  return reviews.map((r) => {
    const from = last.get(r.author) ?? since;
    last.set(r.author, r.at);
    const lines = rows
      .filter((c) => c.author === r.author && c.at > from && c.at <= r.at)
      .map(({ path, line, body }) => ({ path, line, body }));
    return { ...r, lines };
  });
}

interface LineRow {
  pull: string;
  author: string;
  path: string;
  line: number;
  body: string;
  at: string;
}

/** The line comments of the given pulls in one read, by pull, oldest first. */
function linesOf(db: Database, ids: readonly string[]): Map<string, LineRow[]> {
  const out = new Map<string, LineRow[]>();
  if (ids.length === 0) return out;
  for (const row of db
    .query<LineRow, string[]>(
      `SELECT c.issue_id AS pull, u.username AS author, c.path, c.line, c.body, c.created_at AS at
         FROM comment c JOIN user u ON u.id = c.author_id
        WHERE c.issue_id IN (${ids.map((_, n) => `?${n + 1}`).join(",")})
          AND c.kind = 'review' AND c.origin_author IS NULL
        ORDER BY c.created_at, c.id`,
    )
    .all(...ids)) {
    const list = out.get(row.pull);
    if (list) list.push(row);
    else out.set(row.pull, [row]);
  }
  return out;
}

/** What a review's quote may run to, and the window before it where a sentence end is preferred. */
const QUOTE_MAX = 600;
const QUOTE_WINDOW = 100;
const LINE_MAX = 200;

/** `text` cut to `QUOTE_MAX`, at a sentence end when one falls in the last `QUOTE_WINDOW`. */
export function quoteCut(text: string): string {
  const t = text.trim();
  if (t.length <= QUOTE_MAX) return t;
  const head = t.slice(0, QUOTE_MAX);
  let end = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g))
    if (m.index! >= QUOTE_MAX - QUOTE_WINDOW) end = m.index! + 1;
  if (end > 0) return head.slice(0, end);
  // The mark takes a unit of the max, and a pair is never left half.
  let room = QUOTE_MAX - 1;
  const last = t.charCodeAt(room - 1);
  if (last >= 0xd800 && last <= 0xdbff) room--;
  return `${t.slice(0, room).trimEnd()}…`;
}

const quoted = (text: string): string[] =>
  text.split("\n").map((l) => (l.trim() === "" ? ">" : `> ${l.replace(/\s+$/, "")}`));

/** The note's body: each review quoted as a markdown blockquote, its line comments listed under it. */
function handoverQuotes(h: Handover): string[] {
  return h.reviews.slice(0, HANDOVER_ROUNDS).flatMap((r, n) => [
    `${n + 1}. ${r.author}:`,
    "",
    ...quoted(quoteCut(r.body) || "no words"),
    ...(r.lines ?? []).flatMap((l) => [
      "",
      `- ${l.path.replace(/\s+/g, " ")}:${l.line}: ${l.body.replace(/\s+/g, " ").trim().slice(0, LINE_MAX)}`,
    ]),
    "",
  ]);
}

/** One line per review, for the card and the thread: who asked, and the first line of what. */
export function handoverLines(h: Handover): string[] {
  return h.reviews.slice(0, HANDOVER_ROUNDS).map((r, n) => {
    const first = (r.body.split("\n").find((l) => l.trim() !== "") ?? "no words")
      .trim()
      .slice(0, 140);
    return `${n + 1}. ${r.author}: ${first}`;
  });
}

/**
 * The open pulls of an autonomous repository whose review loop is spent:
 * the planner's to re-scope, split or send one more round with the
 * reviewer's ask restated, never the owner's. Shaped like a parked issue so
 * the planner's brief and its once-per-pass clock read both alike.
 */
export function handedOverPulls(
  db: Database,
  repo: Repo,
): {
  issueId: string;
  repoId: string;
  number: number;
  title: string;
  reasons: string[];
  byAgent: boolean;
  at: string;
  pull: true;
}[] {
  if (repo.autonomy !== "autonomous") return [];
  const out = [];
  for (const pull of listPulls(db, repo.id, { sealed: true, state: "open", limit: 50 })) {
    if (!pull.authorIsAgent) continue;
    const over = handoverOf(db, repo, pull.id);
    if (over === undefined) continue;
    out.push({
      issueId: pull.id,
      repoId: repo.id,
      number: pull.number,
      title: pull.title,
      reasons: handoverLines(over),
      byAgent: true,
      at: over.at,
      pull: true as const,
    });
  }
  return out;
}

/** The note the pull's thread keeps of the hand-over. */
export function handoverNote(h: Handover, toPlanner = false): string {
  if (toPlanner)
    return [
      `${HANDOVER_NOTE} the reviewer asked for changes three times with no approval between, so the planner re-scopes it: split, replaced, or one more round with the reviewer's ask restated.`,
      "",
      ...handoverQuotes(h),
    ].join("\n").trimEnd();
  return [
    `${HANDOVER_NOTE} the reviewer asked for changes three times with no approval between, so no more feedback runs start here until you say what to try.`,
    "",
    ...handoverQuotes(h),
  ].join("\n").trimEnd();
}

/**
 * `capReached` for many issues of one repository in three reads, not three
 * per issue: the comments in the window, then the runs in it, then each
 * issue's count against its own start. `capOf` is the cap of an issue.
 */
export function capReachedFor(
  db: Database,
  repo: Repo,
  issues: readonly Issue[],
  capOf: (issue: Issue) => number,
  now = new Date(),
): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const windowStart = new Date(now.getTime() - CAP_WINDOW_MS).toISOString();
  const CHUNK = 400;
  for (let i = 0; i < issues.length; i += CHUNK) {
    const batch = issues.slice(i, i + CHUNK);
    const marks = batch.map((_, n) => `?${n + 2}`).join(",");
    const ids = batch.map((b) => b.id);
    const spoke = db
      .query<{ issue_id: string; id: string; at: string }, string[]>(
        `SELECT issue_id, author_id AS id, MAX(created_at) AS at FROM comment
          WHERE issue_id IN (${marks}) AND created_at > ?1 AND origin_author IS NULL
            AND body NOT LIKE 'Parked by the crew%'
          GROUP BY issue_id, author_id`,
      )
      .all(windowStart, ...ids);
    const directors = new Set(directorsAmong(db, repo, spoke.map((s) => s.id)));
    const from = new Map<string, string>();
    for (const s of spoke) {
      if (!directors.has(s.id)) continue;
      const was = from.get(s.issue_id) ?? windowStart;
      if (s.at > was) from.set(s.issue_id, s.at);
    }
    const counts = new Map<string, number>();
    for (const r of db
      .query<{ issue_id: string; created_at: string }, string[]>(
        `SELECT issue_id, created_at FROM run INDEXED BY run_agent_issue_latest
          WHERE issue_id IN (${marks}) AND kind = 'agent' AND created_at > ?1
            AND attempt = 0
            AND reason NOT IN ('review', 'conflict', 'check_failed')
            AND summary NOT LIKE 'interrupted: %'
            AND summary NOT LIKE 'skipped: %'`,
      )
      .all(windowStart, ...ids))
      if (r.created_at > (from.get(r.issue_id) ?? windowStart))
        counts.set(r.issue_id, (counts.get(r.issue_id) ?? 0) + 1);
    for (const b of batch) out.set(b.id, (counts.get(b.id) ?? 0) >= capOf(b));
  }
  return out;
}
