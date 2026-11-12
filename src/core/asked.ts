/**
 * What people asked for, and what became of it.
 *
 * An ask is an issue a person opened — never one an agent filed, never one
 * imported from an origin under someone else's name. Each comes back with
 * its age, the pulls that say they close it, and one state word read from
 * those facts: `shipped` once one of them merged, `building` while one is
 * open or the crew is running on it, `closed` when it closed with nothing
 * merged, `waiting` otherwise. An ask that is not shipped or closed and is
 * older than the stale window is `stale`. A stale ask that is still
 * `waiting` is `flagged`: nothing was built for it. One with a pull open,
 * or the crew on it, is stale and not flagged: something exists, and each
 * pull says when it was opened so a row can say how long it has been open.
 *
 * Every row is derived on read from the issue, pull and run tables, so
 * nothing here can drift from the map. `source` names where the ask came
 * from, so the thought stream can join this list as a second source with
 * the same row shape.
 */

import type { Database } from "bun:sqlite";
import { marksByName, type Mark } from "./marks.ts";
import { alreadyDone, BY_CREW, PARK_LEAD, PARK_LIKE } from "./done_on_main.ts";
import { getIssuesByIds, type Issue } from "./issues.ts";
import { closesFromBody } from "./pulls.ts";
import { getRepo, listReposWritableTo, type Repo } from "./repos.ts";
import { listActiveRuns } from "./runs.ts";
import type { User } from "./users.ts";

/** Every state an ask can be in, in the order it moves through them. */
export const ASKED_STATES = ["waiting", "building", "shipped", "closed"] as const;
export type AskedState = (typeof ASKED_STATES)[number];

export interface AskedPull {
  /** The pull's issue id, for reads; not part of the JSON. */
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "merged" | "closed";
  /** When the pull was opened. */
  readonly openedAt: string;
  /** When it merged; null otherwise. */
  readonly mergedAt: string | null;
  /** Closed by the crew because it could not finish it, not by a person. */
  readonly parked: boolean;
  /** Who opened it. */
  readonly author: string;
}

/**
 * What became of an ask, read from its issue, pulls and runs alone:
 * `parked` and `failed` need the owner; `building` and `unplaced` are in
 * progress; `landed` is merged; `closed` is closed with nothing merged.
 */
export type AskedOutcome =
  | { readonly kind: "landed"; readonly pull: number; readonly at: string }
  | { readonly kind: "building"; readonly by: string; readonly byMark?: Mark; readonly pull: number | null }
  | { readonly kind: "parked"; readonly pull: number; readonly note: string }
  | { readonly kind: "failed"; readonly by: string; readonly byMark?: Mark; readonly at: string }
  | { readonly kind: "unplaced" }
  | { readonly kind: "closed" };

export interface Asked {
  readonly source: "issue";
  readonly repo: Repo;
  readonly issue: Issue;
  /** Who asked: the issue's author. */
  readonly askedBy: string;
  readonly askedAt: string;
  readonly pulls: readonly AskedPull[];
  readonly state: AskedState;
  /** Not shipped or closed, and older than the stale window. */
  readonly stale: boolean;
  /** Stale, and still waiting: no pull open or merged, and nobody on it. */
  readonly flagged: boolean;
  /** The crew's last word on it: its newest agent run or agent comment, on
   * the ask or a pull that closes it. Null when the crew never touched it. */
  readonly lastCrewAt: string | null;
  /** The commits the crew found it done by on the base, while it waits for the asker to close it; empty otherwise. */
  readonly doneBy: readonly string[];
  readonly outcome: AskedOutcome;
}

export type AskedShow = "all" | "unshipped" | "flagged";

export const isAskedShow = (value: unknown): value is AskedShow =>
  value === "all" || value === "unshipped" || value === "flagged";

/** Oldest first is the default: the path is "open the oldest unmet ask". */
export type AskedOrder = "oldest" | "newest";

export const isAskedOrder = (value: unknown): value is AskedOrder =>
  value === "oldest" || value === "newest";

/** How long an ask may wait with nothing built before it is flagged. */
export const STALE_DAYS = 3;

/** The most rows one read returns. */
export const ASKED_LIMIT = 200;

const DAY = 24 * 60 * 60 * 1000;

/** Asks read per step of the scan. */
const SCAN_STEP = 500;

/** An ask with everything but the crew's last activity, which is read per page. */
type Scanned = Omit<Asked, "lastCrewAt" | "doneBy" | "outcome">;

const shown = (a: Scanned, show: AskedShow): boolean =>
  show === "all" ||
  (show === "flagged"
    ? a.flagged
    : a.state === "waiting" || a.state === "building");

interface AskRow {
  id: string;
}

interface PullRow {
  id: string;
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  created_at: string;
  merged_at: string | null;
  parked: number;
  author: string;
}

const placeholders = (n: number, from = 1): string =>
  Array.from({ length: n }, (_, i) => `?${i + from}`).join(",");

/**
 * The repositories a viewer may read asks about: those they can write,
 * narrowed to one when `repoSpec` (`owner/name`) names one of them. Any
 * other name narrows to nothing, so a repository the viewer cannot write is
 * indistinguishable from one that does not exist.
 */
export function askedRepos(
  db: Database,
  viewer: User | undefined,
  repoSpec: string | null | undefined,
): readonly Repo[] {
  const writable = listReposWritableTo(db, viewer, {
    limit: 200,
    withoutArchived: true,
  });
  if (repoSpec === null || repoSpec === undefined || repoSpec === "")
    return writable;
  const [owner, name, ...rest] = repoSpec.split("/");
  const one =
    owner && name && rest.length === 0 ? getRepo(db, owner, name) : undefined;
  return one !== undefined && writable.some((r) => r.id === one.id)
    ? [one]
    : [];
}

/**
 * The pulls that say they close each ask, keyed `repoId#number`: every pull
 * in these repositories, read once — the one join `scan` and `askedCounts`
 * share, so a count can never disagree with the list.
 */
export function pullsByAsk(
  db: Database,
  repoIds: readonly string[],
): Map<string, AskedPull[]> {
  const pulls = new Map<string, AskedPull[]>();
  const rows = db
    .query<PullRow & { repo_id: string }, string[]>(
      `SELECT issue.id, issue.repo_id, issue.number, issue.title, issue.body, issue.state,
              issue.created_at, issue.parked, pull.merged_at,
              user.username AS author
       FROM issue JOIN pull ON pull.issue_id = issue.id JOIN user ON user.id = issue.author_id
       WHERE issue.repo_id IN (${placeholders(repoIds.length)}) AND issue.kind = 'pull'
         AND issue.body LIKE '%#%'
         AND (issue.body LIKE '%close%' OR issue.body LIKE '%fix%' OR issue.body LIKE '%resolve%')
       ORDER BY issue.number`,
    )
    .all(...repoIds);
  for (const row of rows)
    for (const n of closesFromBody(row.body)) {
      const key = `${row.repo_id}#${n}`;
      const list = pulls.get(key) ?? [];
      list.push({
        id: row.id,
        number: row.number,
        title: row.title,
        state:
          row.merged_at !== null
            ? "merged"
            : row.state === "open"
              ? "open"
              : "closed",
        openedAt: row.created_at,
        mergedAt: row.merged_at,
        parked: row.parked === 1,
        author: row.author,
      });
      pulls.set(key, list);
    }
  return pulls;
}

/** A person's issues — not an agent's, not one imported under another name: what counts as an ask. */
const ASK_WHERE = (n: number) => `issue.repo_id IN (${placeholders(n)})
       AND issue.kind = 'issue' AND user.is_agent = 0
       AND issue.origin_author IS NULL`;

/**
 * Every ask in these repositories, in `order`, with its state. It reads a
 * step at a time and in the order asked for, so a caller that stops when
 * its page is full reads no further, and one that reads on misses nothing:
 * however many asks there are, the oldest are the first out.
 */
function* scan(
  db: Database,
  repos: readonly Repo[],
  order: AskedOrder,
  now: number,
): Generator<Scanned> {
  if (repos.length === 0) return;
  const byId = new Map(repos.map((r) => [r.id, r]));
  const repoIds = [...byId.keys()];
  const direction = new Set(
    repos.flatMap((r) =>
      r.directionIssueId === null ? [] : [r.directionIssueId],
    ),
  );

  const pulls = pullsByAsk(db, repoIds);

  const running = new Set(
    listActiveRuns(db, repoIds).flatMap((r) =>
      r.issueId === null ? [] : [r.issueId],
    ),
  );

  // A person's issues: the author is not an agent and the row is native.
  const way = order === "oldest" ? "ASC" : "DESC";
  const step = db.query<AskRow, (string | number)[]>(
    `SELECT issue.id FROM issue JOIN user ON user.id = issue.author_id
     WHERE ${ASK_WHERE(repoIds.length)}
     ORDER BY issue.created_at ${way}, issue.number ${way}, issue.id ${way}
     LIMIT ?${repoIds.length + 1} OFFSET ?${repoIds.length + 2}`,
  );
  for (let offset = 0; ; offset += SCAN_STEP) {
    const ids = step.all(...repoIds, SCAN_STEP, offset).map((r) => r.id);
    const issues = getIssuesByIds(db, ids);
    for (const id of ids) {
      const issue = issues.get(id);
      const repo = issue === undefined ? undefined : byId.get(issue.repoId);
      if (issue === undefined || repo === undefined || direction.has(id))
        continue;
      const its = pulls.get(`${issue.repoId}#${issue.number}`) ?? [];
      const state: AskedState = its.some((p) => p.state === "merged")
        ? "shipped"
        : its.some((p) => p.state === "open") || running.has(issue.id)
          ? "building"
          : issue.state === "closed"
            ? "closed"
            : "waiting";
      const stale =
        (state === "waiting" || state === "building") &&
        now - Date.parse(issue.createdAt) > STALE_DAYS * DAY;
      yield {
        source: "issue",
        repo,
        issue,
        askedBy: issue.authorName,
        askedAt: issue.createdAt,
        pulls: its,
        state,
        stale,
        flagged: stale && state === "waiting",
      };
    }
    if (ids.length < SCAN_STEP) return;
  }
}

/**
 * The asks in these repositories, oldest first unless `order` says newest:
 * the first `limit` that `show` lets through. The caller decides which
 * repositories the viewer may read this about (writers of each).
 */
export function askedIn(
  db: Database,
  repos: readonly Repo[],
  options: {
    show?: AskedShow;
    order?: AskedOrder;
    now?: Date;
    limit?: number;
  } = {},
): Asked[] {
  const show = options.show ?? "unshipped";
  const limit = Math.min(
    Math.max(options.limit ?? ASKED_LIMIT, 1),
    ASKED_LIMIT,
  );
  const page: Scanned[] = [];
  for (const ask of scan(
    db,
    repos,
    options.order ?? "oldest",
    (options.now ?? new Date()).getTime(),
  )) {
    if (!shown(ask, show)) continue;
    page.push(ask);
    if (page.length === limit) break;
  }
  const last = lastCrewActivity(
    db,
    page.flatMap((a) => [a.issue.id, ...a.pulls.map((p) => p.id)]),
  );
  const done = alreadyDone(
    db,
    page.filter((a) => a.issue.state === "open").map((a) => a.issue.id),
  );
  const outcomes = outcomesOf(db, page);
  return page.map((a) => {
    let at: string | null = last.get(a.issue.id) ?? null;
    for (const p of a.pulls) {
      const t = last.get(p.id);
      if (t !== undefined && (at === null || t > at)) at = t;
    }
    return {
      ...a,
      lastCrewAt: at,
      doneBy: done.get(a.issue.id) ?? [],
      outcome: outcomes.get(a.issue.id)!,
    };
  });
}

/** The first sentence of a parking note, without the crew's fixed lead-in. */
export function firstSentence(text: string): string {
  const lead = text.startsWith(PARK_LEAD) ? text.slice(PARK_LEAD.length).replace(/^:\s*/, "") : text;
  const plain = lead.replace(/\s+/g, " ").trim();
  const end = plain.search(/[.!?](\s|$)/);
  return end === -1 ? plain : plain.slice(0, end + 1);
}

type Run = { state: string; by: string; at: string };

/** The newest agent run of each issue or pull in `ids`, in grouped reads. */
function lastRuns(db: Database, ids: readonly string[]): Map<string, Run> {
  const out = new Map<string, Run>();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    for (const r of db
      .query<{ issue_id: string; state: string; by: string | null; at: string }, string[]>(
        `SELECT run.issue_id, run.state, user.username AS by, run.created_at AS at
         FROM run LEFT JOIN user ON user.id = run.actor_id
         WHERE run.kind = 'agent' AND run.issue_id IN (${placeholders(batch.length)})
         ORDER BY run.created_at, run.id`,
      )
      .all(...batch))
      out.set(r.issue_id, { state: r.state, by: r.by ?? "the crew", at: r.at });
  }
  return out;
}

/** The newest parking note on each of the pulls `ids`, in grouped reads. */
function parkingNotes(db: Database, ids: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 400) {
    const batch = ids.slice(i, i + 400);
    for (const c of db
      .query<{ issue_id: string; body: string }, string[]>(
        `SELECT n.issue_id, n.body FROM comment n
         WHERE n.body LIKE '${PARK_LIKE}' AND ${BY_CREW} AND n.issue_id IN (${placeholders(batch.length)})
         ORDER BY n.created_at, n.id`,
      )
      .all(...batch))
      out.set(c.issue_id, c.body);
  }
  return out;
}

const newest = <T>(items: readonly T[], keep: (item: T) => boolean): T | undefined => {
  for (let i = items.length - 1; i >= 0; i--) if (keep(items[i]!)) return items[i];
  return undefined;
};

/** The outcome of each ask: its pulls first, then the issue, then the newest agent run. */
function outcomesOf(db: Database, page: readonly Scanned[]): Map<string, AskedOutcome> {
  const runs = lastRuns(db, page.flatMap((a) => [a.issue.id, ...a.pulls.map((p) => p.id)]));
  const notes = parkingNotes(db, page.flatMap((a) => a.pulls.filter((p) => p.parked).map((p) => p.id)));
  const out = new Map<string, AskedOutcome>();
  for (const a of page) {
    const merged = newest(a.pulls, (p) => p.state === "merged");
    const open = newest(a.pulls, (p) => p.state === "open");
    const parked = newest(a.pulls, (p) => p.parked);
    let run: Run | undefined;
    for (const id of [a.issue.id, ...a.pulls.map((p) => p.id)]) {
      const r = runs.get(id);
      if (r !== undefined && (run === undefined || r.at > run.at)) run = r;
    }
    let outcome: AskedOutcome;
    if (merged !== undefined)
      outcome = { kind: "landed", pull: merged.number, at: merged.mergedAt ?? merged.openedAt };
    else if (open !== undefined) outcome = { kind: "building", by: open.author, pull: open.number };
    else if (a.state === "building") outcome = { kind: "building", by: run?.by ?? "the crew", pull: null };
    else if (a.state === "closed") outcome = { kind: "closed" };
    else if (parked !== undefined)
      outcome = { kind: "parked", pull: parked.number, note: firstSentence(notes.get(parked.id) ?? "") };
    else if (run?.state === "failed") outcome = { kind: "failed", by: run.by, at: run.at };
    else outcome = { kind: "unplaced" };
    out.set(a.issue.id, outcome);
  }
  // A name says who it is: the mark comes from the account, never from the name.
  const marks = marksByName(db, [...out.values()].flatMap((o) => ("by" in o ? [o.by] : [])));
  for (const [id, o] of out) {
    const byMark = "by" in o ? marks.get(o.by) : undefined;
    if (byMark !== undefined && "by" in o) out.set(id, { ...o, byMark });
  }
  return out;
}

/** 0 needs the owner, 1 is in progress, 2 landed, 3 closed with nothing merged. */
export function askedTier(a: Asked): 0 | 1 | 2 | 3 {
  if (a.doneBy.length > 0 && a.outcome.kind !== "closed") return 0;
  switch (a.outcome.kind) {
    case "parked":
    case "failed":
      return 0;
    case "building":
    case "unplaced":
      return 1;
    case "landed":
      return 2;
    case "closed":
      return 3;
  }
}

/** A name with its mark word, as the terminal and the API print it. */
const named = (by: string, mark: Mark | undefined): string => (mark === undefined ? by : `${by} (${mark})`);

/** What became of the ask as plain words, for the terminal; the page links the same words. */
export function outcomeText(a: Asked): string {
  if (a.doneBy.length > 0)
    return `on main in ${a.doneBy.map((o) => o.slice(0, 7)).join(", ")}, waiting for you to close it`;
  const o = a.outcome;
  switch (o.kind) {
    case "landed":
      return `landed in #${o.pull}`;
    case "building":
      return o.pull === null ? `${named(o.by, o.byMark)} building` : `${named(o.by, o.byMark)} building in #${o.pull}`;
    case "parked":
      return `parked: ${o.note === "" ? "no note left" : o.note}`;
    case "failed":
      return `${named(o.by, o.byMark)} failed`;
    case "unplaced":
      return "not placed yet";
    case "closed":
      return "closed, nothing merged";
  }
}

export interface AskedCounts {
  /** Every ask. */
  readonly asked: number;
  readonly shipped: number;
  /** Waiting or building: what `show=unshipped` lists. */
  readonly unshipped: number;
  /** What `show=flagged` lists. */
  readonly flagged: number;
}

/**
 * How many asks there are of each kind, over all of them, not one page —
 * counted in SQL, never by reading every ask: the pulls that close asks are
 * read once (`pullsByAsk`) and handed to one grouped query as key sets, so
 * the cost follows the pulls, not the tens of thousands of issues a busy
 * repository can carry. The states are `scan`'s, word for word.
 */
export function askedCounts(
  db: Database,
  repos: readonly Repo[],
  now: Date = new Date(),
): AskedCounts {
  if (repos.length === 0) return { asked: 0, shipped: 0, unshipped: 0, flagged: 0 };
  const repoIds = repos.map((r) => r.id);
  const shipped: string[] = [];
  const open: string[] = [];
  for (const [key, list] of pullsByAsk(db, repoIds)) {
    if (list.some((p) => p.state === "merged")) shipped.push(key);
    else if (list.some((p) => p.state === "open")) open.push(key);
  }
  const running = listActiveRuns(db, repoIds).flatMap((r) =>
    r.issueId === null ? [] : [r.issueId],
  );
  const direction = repos.flatMap((r) =>
    r.directionIssueId === null ? [] : [r.directionIssueId],
  );
  const n = repoIds.length;
  const set = (k: number) => `(SELECT value FROM json_each(?${n + k}))`;
  const row = db
    .query<
      { asked: number; shipped: number; building: number; waiting: number; flagged: number },
      string[]
    >(
      `SELECT COUNT(*) AS asked,
              COALESCE(SUM(shipped), 0) AS shipped,
              COALESCE(SUM(building), 0) AS building,
              COALESCE(SUM(waiting), 0) AS waiting,
              COALESCE(SUM(waiting AND created_at < ?${n + 5}), 0) AS flagged
       FROM (
         SELECT shipped,
                NOT shipped AND (k IN ${set(2)} OR id IN ${set(3)}) AS building,
                NOT shipped AND NOT (k IN ${set(2)} OR id IN ${set(3)}) AND state = 'open' AS waiting,
                created_at
         FROM (
           SELECT issue.id AS id, issue.state AS state, issue.created_at AS created_at,
                  issue.repo_id || '#' || issue.number AS k,
                  (issue.repo_id || '#' || issue.number) IN ${set(1)} AS shipped
           FROM issue JOIN user ON user.id = issue.author_id
           WHERE ${ASK_WHERE(n)} AND issue.id NOT IN ${set(4)}
         )
       )`,
    )
    .get(
      ...repoIds,
      JSON.stringify(shipped),
      JSON.stringify(open),
      JSON.stringify(running),
      JSON.stringify(direction),
      new Date(now.getTime() - STALE_DAYS * DAY).toISOString(),
    )!;
  return {
    asked: row.asked,
    shipped: row.shipped,
    unshipped: row.building + row.waiting,
    flagged: row.flagged,
  };
}

/** The newest agent run or agent comment per issue, in two grouped reads. */
function lastCrewActivity(
  db: Database,
  issueIds: readonly string[],
): Map<string, string> {
  const out = new Map<string, string>();
  const unique = [...new Set(issueIds)];
  const CHUNK = 400;
  for (let i = 0; i < unique.length; i += CHUNK) {
    const batch = unique.slice(i, i + CHUNK);
    const marks = placeholders(batch.length);
    const rows = db
      .query<{ issue_id: string; at: string }, string[]>(
        `SELECT issue_id, MAX(created_at) AS at FROM run
         WHERE kind = 'agent' AND issue_id IN (${marks}) GROUP BY issue_id
         UNION ALL
         SELECT comment.issue_id, MAX(comment.created_at) AS at
         FROM comment JOIN user ON user.id = comment.author_id
         WHERE user.is_agent = 1 AND comment.issue_id IN (${marks})
         GROUP BY comment.issue_id`,
      )
      .all(...batch);
    for (const r of rows) {
      const seen = out.get(r.issue_id);
      if (seen === undefined || r.at > seen) out.set(r.issue_id, r.at);
    }
  }
  return out;
}

/** The row as JSON, for the API and the MCP. */
export function askedJson(a: Asked) {
  return {
    source: a.source,
    repo: `${a.repo.ownerName}/${a.repo.name}`,
    number: a.issue.number,
    title: a.issue.title,
    askedBy: a.askedBy,
    askedAt: a.askedAt,
    issueState: a.issue.state,
    state: a.state,
    stale: a.stale,
    flagged: a.flagged,
    lastCrewAt: a.lastCrewAt,
    doneBy: a.doneBy,
    outcome: a.outcome,
    outcomeText: outcomeText(a),
    pulls: a.pulls.map((p) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      openedAt: p.openedAt,
    })),
  };
}
