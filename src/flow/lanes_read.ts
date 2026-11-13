/**
 * The reads behind the new home's lanes (`flow/lanes.ts` draws them): what
 * is in each pipeline stage, plain data over a database handle. Nothing here
 * touches the forge's one thread: `lanes_worker.ts` runs it on a read-only
 * handle of its own, and the thread only receives the answer.
 *
 * Two cadences. The fast part (running and queued work, approved and merged
 * pulls, deploys) is a few indexed reads, bounded, a few milliseconds, and
 * is read whenever the picture is due. The slow part (the crew's own order
 * for what is asked next, the figures and the alarms) costs a few hundred
 * milliseconds on production's database and changes by the minute: the
 * worker keeps it 30 seconds. Every lane is bounded to the newest few items
 * and a count, never every row: on production the deploy ledger alone holds
 * ten million rows, and a count over it is what made the first version of
 * this read take 2.5 s.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import { nextUp, type NextRow } from "../core/next_up.ts";
import { idleReason, type IdleReason } from "../crew/idle_reason.ts";
import { listAutonomousRepos } from "../core/repos.ts";
import { weekShare } from "../crew/week_read.ts";
import { firedAlarms } from "./alarms.ts";
import { readBuilders, readKpis } from "./kpis.ts";
import { readFigures, type Figures } from "./figures.ts";
import { readLeadTime, type LeadTime } from "./lead_time.ts";
import { shortTitle } from "./moving.ts";
import { getUserById } from "../core/users.ts";
import { reviewSetOf } from "../web/studio/review_set.ts";

export const LANES = [
  "asked",
  "building",
  "checks",
  "review",
  "landing",
  "live",
] as const;
export type LaneKey = (typeof LANES)[number];

/** Items a lane lists; the rest are counted. */
export const LANE_ITEMS = 12;
/** Rows read per lane before a viewer's access filters them. */
const SCAN = 40;
/** What "recently" means for whether a lane is moving. */
export const MOVED_MS = 30 * 60_000;
/** How long the slow part is kept by the worker. */
export const SLOW_MS = 30_000;

export interface LaneItem {
  /** Stable across lanes: the same change keeps its key as it moves, so the page can move its tile. */
  readonly key: string;
  readonly repoId: string;
  readonly kind: "issue" | "pull" | "main" | "deploy";
  readonly number: number | null;
  readonly title: string;
  readonly sealed: boolean;
  /** Who has it: the crew member, the reviewer, the person who asked or merged. Empty when no one does. */
  readonly who: string;
  /** When it entered this lane. */
  readonly since: string;
  /** Waiting for a worker or a person, being worked, or (live) done and serving. */
  readonly state: "waiting" | "active" | "done";
  /** One plain sentence of where it is, without a clock: the page draws the clock beside it. */
  readonly hint: string;
  /** Its place in the line, from 1, for items that queue. */
  readonly position: number | null;
  /** When its worker last said it was alive; null when it does not say. */
  readonly beat: string | null;
  /** The issue or pull this is, for an action over it (`fleet/verbs.ts`); null for a check of main and a deploy. */
  readonly issueId: string | null;
  /** When the issue or pull was opened; null where there is none. */
  readonly born: string | null;
}

export interface LaneRead {
  readonly items: readonly LaneItem[];
  /** Everything in the lane, not only what was read. */
  readonly total: number;
}

/** What the strip above the lanes reads. */
export interface StripPart {
  readonly landed: number;
  readonly landedHours: readonly number[];
  readonly lead: LeadTime;
  /** The provider's week, when it has reported one. */
  readonly week: {
    readonly usedPct: number;
    readonly mayUsePct: number;
  } | null;
  /** The crew's spend over seven days at list price, for the forge's own estimate when the provider has not reported. */
  readonly weekSpendUsd: number;
  readonly ceilingUsd: number | null;
  readonly needs: readonly { readonly says: string; readonly href: string }[];
}

export interface LanePicture {
  /** When it was read, ms. */
  readonly at: number;
  /** The write clock the read began at; undefined for a database that has none. */
  readonly stamp: string | undefined;
  readonly lanes: Readonly<Record<LaneKey, LaneRead>>;
  /** A short hash of what each lane shows, clocks left out: the lane's ETag. */
  readonly versions: Readonly<Record<LaneKey, string>>;
  /** Items that entered or left each lane in the last 30 minutes: whether it is moving. */
  readonly moved: Readonly<Record<LaneKey, number>>;
  readonly builders: { readonly running: number; readonly slots: number };
  readonly strip: StripPart | null;
  /** What waits on each viewer the worker was told of: how many asks and since when the oldest. */
  readonly asks: Readonly<Record<string, AsksWaiting>>;
  /** The home's figures; null until the slow part has been read. */
  readonly figures: Figures | null;
  /** Why no builder is starting anything, when something names it (the day's ceiling, no subscription with room, nothing ready); null otherwise. */
  readonly idle: IdleReason | null;
}

/** The asks waiting on one person (`web/studio/review_set.ts`): the live ones, not the stale. */
export interface AsksWaiting {
  readonly count: number;
  readonly oldest: string | null;
}

interface Raw {
  id: string;
  repo_id: string;
  number: number | null;
  kind: string | null;
  title: string | null;
  sealed: number | null;
  who: string | null;
  since: string;
  state: string;
  reason: string | null;
  attempt: number | null;
  env: string | null;
  beat: string | null;
  issue_id: string | null;
  born: string | null;
  total: number;
}

const BUILD_WORDS: Record<string, string> = {
  conflict: "Resolving a merge conflict.",
  check_failed: "Fixing a failed check.",
  feedback: "Answering review notes.",
};

/** The queue position of each waiting row, from 1, oldest first: the order the next worker takes them. */
function positioned(rows: readonly Raw[]): Map<string, number> {
  const out = new Map<string, number>();
  let n = 0;
  for (const r of rows
    .filter((x) => x.state === "queued")
    .sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0)))
    out.set(r.id, ++n);
  return out;
}

const ordinal = (n: number): string =>
  n === 1
    ? "next in line"
    : `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")} in line`;

function item(
  r: Raw,
  over: Partial<LaneItem> & Pick<LaneItem, "state" | "hint">,
): LaneItem {
  const title = (r.title ?? "").replace(/\s+/g, " ").trim();
  return {
    key: `i-${r.id}`,
    repoId: r.repo_id,
    kind:
      r.kind === "pull"
        ? "pull"
        : r.kind === "main"
          ? "main"
          : r.kind === "deploy"
            ? "deploy"
            : "issue",
    number: r.number,
    title: shortTitle(title, 72),
    sealed: (r.sealed ?? 0) !== 0,
    who: r.who ?? "",
    since: r.since,
    position: null,
    beat: r.beat,
    issueId: r.issue_id,
    born: r.born,
    ...over,
  };
}

/** Runs of one kind in flight, running first and then by age; a queued run paused on a limit is not waiting for a worker. */
function runRows(
  db: Database,
  kind: "agent" | "check",
  where: string,
  now: string,
): Raw[] {
  return db
    .query<Raw, [string, string, number]>(
      `SELECT COALESCE(i.id, x.id) AS id, x.repo_id, i.number, CASE WHEN i.id IS NULL THEN 'main' ELSE i.kind END AS kind, i.title, i.sealed,
              u.username AS who, CASE WHEN x.state = 'running' THEN COALESCE(x.started_at, x.created_at) ELSE x.created_at END AS since,
              x.state, x.reason, x.attempt, x.env, x.heartbeat_at AS beat, i.id AS issue_id, i.created_at AS born, COUNT(*) OVER () AS total
         FROM run x LEFT JOIN issue i ON i.id = x.issue_id LEFT JOIN user u ON u.id = x.actor_id
        WHERE x.kind = ?1 AND x.state IN ('queued','running') AND ${where}
          AND (x.state = 'running' OR x.not_before IS NULL OR x.not_before <= ?2)
        ORDER BY x.state DESC, x.created_at ASC LIMIT ?3`,
    )
    .all(kind, now, SCAN);
}

/** Approved pulls waiting for a person, oldest approval first. */
function approvedRows(db: Database): Raw[] {
  return db
    .query<Raw, [number]>(
      `SELECT i.id, i.repo_id, i.number, 'pull' AS kind, i.title, i.sealed, u.username AS who, v.created_at AS since,
              'approved' AS state, NULL AS reason, NULL AS attempt, NULL AS env, NULL AS beat, i.id AS issue_id, i.created_at AS born, COUNT(*) OVER () AS total
         FROM issue i JOIN pull p ON p.issue_id = i.id
         JOIN review v ON v.id = (SELECT id FROM review WHERE issue_id = i.id AND state != 'commented'
                                   ORDER BY created_at DESC, id DESC LIMIT 1)
         LEFT JOIN user u ON u.id = v.author_id
        WHERE i.kind = 'pull' AND i.state = 'open' AND v.state = 'approved'
        ORDER BY v.created_at ASC LIMIT ?1`,
    )
    .all(SCAN);
}

/** Pulls merged in the last week with no production deploy since: landed, not yet live. */
function mergedRows(db: Database, weekAgo: string): Raw[] {
  return db
    .query<Raw, [string, number]>(
      `SELECT i.id, i.repo_id, i.number, 'pull' AS kind, i.title, i.sealed, u.username AS who, p.merged_at AS since,
              'merged' AS state, NULL AS reason, NULL AS attempt, NULL AS env, NULL AS beat, i.id AS issue_id, i.created_at AS born, COUNT(*) OVER () AS total
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
         JOIN app a ON a.repo_id = r.id LEFT JOIN user u ON u.id = p.merged_by
        WHERE p.merged_at >= ?1 AND p.base_branch = r.default_branch
          AND NOT EXISTS (SELECT 1 FROM run d WHERE d.repo_id = r.id AND d.kind = 'deploy'
                           AND d.env = 'production' AND d.created_at >= p.merged_at)
        ORDER BY p.merged_at DESC LIMIT ?2`,
    )
    .all(weekAgo, SCAN);
}

interface Deploy {
  id: string;
  repo_id: string;
  state: string;
  at: string;
  who: string | null;
}

/**
 * Production deploys going live now and those that went live in the last 24
 * hours, newest first. Only the ids and times come from the run table, and
 * only through its own two small indexes (`run_live`, `run_queue`), named (`INDEXED BY`) because the planner picks `run_kind_state` and walks every deploy: the
 * deploy ledger (`deploy_pull`) is never counted or sorted, because a deploy
 * lists every change it carries and production's holds ten million rows.
 */
function deploys(
  db: Database,
  dayAgo: string,
): { rows: Deploy[]; total: number } {
  const served = db
    .query<Deploy, [string, number]>(
      `SELECT x.id, x.repo_id, x.state, x.serving_at AS at, u.username AS who
         FROM run x INDEXED BY run_live LEFT JOIN user u ON u.id = x.actor_id
        WHERE x.kind = 'deploy' AND x.env = 'production' AND x.serving_at >= ?1
        ORDER BY x.serving_at DESC LIMIT ?2`,
    )
    .all(dayAgo, SCAN);
  const total =
    db
      .query<
        { n: number },
        [string]
      >(`SELECT COUNT(*) AS n FROM run x INDEXED BY run_live WHERE x.kind = 'deploy' AND x.env = 'production' AND x.serving_at >= ?1`)
      .get(dayAgo)?.n ?? served.length;
  const going = db
    .query<Deploy, []>(
      `SELECT x.id, x.repo_id, x.state, COALESCE(x.started_at, x.created_at) AS at, u.username AS who
         FROM run x LEFT JOIN user u ON u.id = x.actor_id
        WHERE x.kind = 'deploy' AND x.env = 'production' AND x.state IN ('queued','running')
        ORDER BY x.created_at DESC LIMIT 8`,
    )
    .all();
  return { rows: [...going, ...served], total: total + going.length };
}

/**
 * The change a deploy put live: the newest merged pull of its repository at
 * or before it, by number (the repository's own index, a few rows from the
 * top), never the ledger of what the deploy carried.
 */
function carried(
  db: Database,
  repoId: string,
  at: string,
): { id: string; number: number; title: string } | undefined {
  return (
    db
      .query<{ id: string; number: number; title: string }, [string, string]>(
        `SELECT i.id, i.number, i.title FROM issue i JOIN pull p ON p.issue_id = i.id
          WHERE i.repo_id = ?1 AND i.kind = 'pull' AND i.state = 'closed' AND p.merged_at IS NOT NULL AND p.merged_at <= ?2
          ORDER BY i.number DESC LIMIT 1`,
      )
      .get(repoId, at) ?? undefined
  );
}

function building(rows: readonly Raw[]): LaneRead {
  const line = positioned(rows);
  const items = rows.map((r) =>
    r.state === "running"
      ? item(r, {
          state: "active",
          hint:
            (r.attempt ?? 0) > 1
              ? `Writing the change, try ${r.attempt}.`
              : (BUILD_WORDS[r.reason ?? ""] ?? "Writing the change."),
        })
      : item(r, {
          state: "waiting",
          position: line.get(r.id) ?? null,
          hint: `Waiting for a builder, ${ordinal(line.get(r.id) ?? 1)}.`,
        }),
  );
  return { items, total: rows[0]?.total ?? 0 };
}

function checks(rows: readonly Raw[]): LaneRead {
  const line = positioned(rows);
  const items = rows.map((r) => {
    const what =
      r.kind === "main"
        ? r.env === "verify" || r.env === "verify-bisect"
          ? "Checking the live version"
          : "Checking main after a landing"
        : "Running the tests";
    return r.state === "running"
      ? item(r, { state: "active", hint: `${what}.` })
      : item(r, {
          state: "waiting",
          position: line.get(r.id) ?? null,
          hint: `Waiting for a test runner, ${ordinal(line.get(r.id) ?? 1)}.`,
        });
  });
  return { items, total: rows[0]?.total ?? 0 };
}

function review(rows: readonly Raw[]): LaneRead {
  const line = positioned(rows);
  const items = rows.map((r) =>
    r.state === "running"
      ? item(r, { state: "active", hint: "Being read by a reviewer." })
      : item(r, {
          state: "waiting",
          position: line.get(r.id) ?? null,
          hint: `Waiting for a reviewer, ${ordinal(line.get(r.id) ?? 1)}.`,
        }),
  );
  return { items, total: rows[0]?.total ?? 0 };
}

function landing(approved: readonly Raw[], merged: readonly Raw[]): LaneRead {
  const items = [
    ...approved.map((r, i) =>
      item(r, {
        state: "waiting",
        position: i + 1,
        hint: "Approved: waits for you to land it.",
      }),
    ),
    ...merged.map((r) =>
      item(r, { state: "active", hint: "Landed: going live next." }),
    ),
  ];
  return { items, total: (approved[0]?.total ?? 0) + (merged[0]?.total ?? 0) };
}

function live(db: Database, dayAgo: string): LaneRead {
  const { rows, total } = deploys(db, dayAgo);
  const seen = new Set<string>();
  const items: LaneItem[] = [];
  // Enough to list; the carried-change lookup is a few rows each, so it is bounded to what a lane draws.
  for (const d of rows) {
    if (items.length >= LANE_ITEMS + 3) break;
    const going = d.state === "queued" || d.state === "running";
    const change = carried(db, d.repo_id, d.at);
    // A tile is the change it put live, keyed as the change (so Landing's tile arrives here); a deploy that names none is keyed by itself.
    const key = `i-${change?.id ?? d.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      key,
      repoId: d.repo_id,
      kind: "deploy",
      number: change?.number ?? null,
      title: shortTitle(change?.title ?? "A new version of the app", 72),
      sealed: false,
      who: d.who ?? "",
      since: d.at,
      state: going ? "active" : "done",
      hint: going ? "Going live now." : "Serving now.",
      position: null,
      beat: null,
      issueId: null,
      born: null,
    });
  }
  return { items, total };
}

/** Items of one lane that came into or left it since `since`: whether the lane is moving. */
function countSince(db: Database, sql: string, since: string): number {
  return db.query<{ n: number }, [string]>(sql).get(since)?.n ?? 0;
}

export interface Fast {
  readonly lanes: Readonly<Record<Exclude<LaneKey, "asked">, LaneRead>>;
  readonly moved: Readonly<Record<LaneKey, number>>;
  readonly builders: { readonly running: number; readonly slots: number };
  /** Issues with a build in flight: they have left Asked, whatever the slow part last said. */
  readonly working: ReadonlySet<string>;
}

/** The fast part: running and queued work, approved and merged pulls, deploys. A few indexed reads, each bounded. */
export function readFast(db: Database, now: Date): Fast {
  const iso = now.toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const recent = new Date(now.getTime() - MOVED_MS).toISOString();
  const b = readBuilders(db);
  const working = new Set(
    db
      .query<{ issue_id: string }, []>(
        `SELECT issue_id FROM run WHERE kind = 'agent' AND state IN ('queued','running') AND issue_id IS NOT NULL`,
      )
      .all()
      .map((r) => r.issue_id),
  );
  const started = countSince(
    db,
    `SELECT COUNT(*) AS n FROM run WHERE kind = 'agent' AND reason != 'review' AND started_at >= ?1`,
    recent,
  );
  return {
    lanes: {
      building: building(runRows(db, "agent", "x.reason != 'review'", iso)),
      checks: checks(runRows(db, "check", "1 = 1", iso)),
      review: review(runRows(db, "agent", "x.reason = 'review'", iso)),
      landing: landing(approvedRows(db), mergedRows(db, week)),
      live: live(db, day),
    },
    moved: {
      asked: started,
      building: started,
      checks: countSince(
        db,
        `SELECT COUNT(*) AS n FROM run WHERE kind = 'check' AND started_at >= ?1`,
        recent,
      ),
      review: countSince(
        db,
        `SELECT COUNT(*) AS n FROM run WHERE kind = 'agent' AND reason = 'review' AND started_at >= ?1`,
        recent,
      ),
      landing: countSince(
        db,
        `SELECT COUNT(*) AS n FROM pull WHERE merged_at >= ?1`,
        recent,
      ),
      live: countSince(
        db,
        `SELECT COUNT(*) AS n FROM run INDEXED BY run_live WHERE kind = 'deploy' AND env = 'production' AND serving_at >= ?1`,
        recent,
      ),
    },
    builders: { running: b.running, slots: b.slots },
    working,
  };
}

export interface Slow {
  /** The crew's next asks in its own order, a few more than a lane draws so a build starting leaves the lane full. */
  readonly asked: readonly LaneItem[];
  readonly askedTotal: number;
  readonly strip: StripPart;
  readonly figures: Figures;
  readonly asks: Readonly<Record<string, AsksWaiting>>;
  readonly idle: IdleReason | null;
}

/** How many of the crew's next asks the slow part keeps. */
const ASKED_KEPT = 16;

/**
 * The next asks in the order the crew will take them (`core/next_up.ts`,
 * which is also what the crew's own picker reads): what a person ranked
 * first, in rank order, then each app's ready work in turn, so one busy app
 * does not hide the rest. The count is every ready ask.
 */
function askedNext(db: Database): { items: LaneItem[]; total: number } {
  const ranked: NextRow[] = [];
  const queues: NextRow[][] = [];
  let total = 0;
  for (const repo of listAutonomousRepos(db)) {
    const ready = nextUp(db, repo).rows.filter((r) => r.state === "ready");
    total += ready.length;
    for (const r of ready) if (r.place !== null && r.byOwner) ranked.push(r);
    queues.push(ready.filter((r) => !(r.place !== null && r.byOwner)));
  }
  ranked.sort((a, b) => (a.place ?? 0) - (b.place ?? 0));
  const order = [...ranked];
  for (
    let i = 0;
    order.length < ASKED_KEPT && queues.some((q) => i < q.length);
    i++
  )
    for (const q of queues)
      if (i < q.length && order.length < ASKED_KEPT) order.push(q[i]!);
  const items = order.map(
    (r): LaneItem => ({
      key: `i-${r.issue.id}`,
      repoId: r.issue.repoId,
      kind: "issue",
      number: r.issue.number,
      title: shortTitle(r.issue.title.replace(/\s+/g, " ").trim(), 72),
      sealed: r.issue.sealed,
      who: r.issue.authorName,
      since: r.issue.createdAt,
      state: "waiting",
      hint:
        r.place !== null && r.byOwner ? "You put this one first." : "Ready.",
      position: null,
      beat: null,
      issueId: r.issue.id,
      born: r.issue.createdAt,
    }),
  );
  return { items, total };
}

/** The slow part: the crew's order, the figures, the alarms and the week. `app` is the two things the week reads (a database and a data directory), nothing else. */
export function readSlow(
  db: Database,
  now: Date,
  forge: { readonly dataDir: string; readonly ceilingUsd: number | null },
  viewers: readonly string[] = [],
): Slow {
  const asked = askedNext(db);
  const kpis = readKpis(db, now, {
    ceilingUsd: forge.ceilingUsd,
    dataDir: forge.dataDir,
  });
  const lead = readLeadTime(db, now);
  const week = weekShare(
    { db, config: { dataDir: forge.dataDir } } as unknown as App,
    now,
  );
  const spend = db
    .query<
      { usd: number | null },
      [string]
    >(`SELECT SUM(cost_usd) AS usd FROM run WHERE kind = 'agent' AND created_at >= ?1`)
    .get(new Date(now.getTime() - 7 * 86_400_000).toISOString());
  const REAL = new Set([
    "red_main",
    "landing_stopped",
    "lane_stopped",
    "stuck",
    "unreachable",
    "backup",
    "no_release",
  ]);
  const needs = firedAlarms(db, now, {
    dataDir: forge.dataDir,
    ceilingUsd: forge.ceilingUsd,
  })
    .filter((a) => REAL.has(a.key))
    .map((a) => ({ says: a.says, href: a.href }));
  return {
    asked: asked.items,
    askedTotal: asked.total,
    strip: {
      landed: kpis.landed,
      landedHours: kpis.landedHours,
      lead,
      week,
      weekSpendUsd: spend?.usd ?? 0,
      ceilingUsd: forge.ceilingUsd,
      needs,
    },
    figures: readFigures(db, now, kpis),
    asks: asksOf(db, viewers, now),
    idle: idleOf(db, forge.dataDir, now),
  };
}

/** Why the builders sit idle, from the same module the dispatcher is asked in; `app` is the database and the data directory, the two things it reads. */
function idleOf(db: Database, dataDir: string, now: Date): IdleReason | null {
  try {
    return idleReason({ db, config: { dataDir } } as unknown as App, now);
  } catch {
    return null;
  }
}

/** What waits on each viewer: the same set `/review` draws (`reviewSetOf`), counted per person the worker was told of. */
function asksOf(db: Database, viewers: readonly string[], now: Date): Record<string, AsksWaiting> {
  const out: Record<string, AsksWaiting> = {};
  for (const id of viewers) {
    const user = getUserById(db, id);
    if (user === undefined) {
      out[id] = { count: 0, oldest: null };
      continue;
    }
    const set = reviewSetOf(db, user, now);
    out[id] = { count: set.count, oldest: set.live.reduce<string | null>((o, a) => (o === null || Date.parse(a.since) < Date.parse(o) ? a.since : o), null) };
  }
  return out;
}

/** A short hash of what a lane shows: its items without the heartbeat, which moves every few seconds and is no change. */
function versionOf(read: LaneRead): string {
  return Bun.hash(
    JSON.stringify([
      read.total,
      read.items.map((i) => ({ ...i, beat: i.beat === null ? null : 1 })),
    ]),
  ).toString(36);
}

/** The picture from a fast part and the slow part the worker last kept. */
export function compose(
  fast: Fast,
  slow: Slow | undefined,
  now: number,
  stamp: string | undefined,
): LanePicture {
  const askedItems = (slow?.asked ?? []).filter(
    (i) => !fast.working.has(i.key.slice(2)),
  );
  const gone = (slow?.asked.length ?? 0) - askedItems.length;
  const asked: LaneRead = {
    items: askedItems.slice(0, LANE_ITEMS + 3),
    total: Math.max(askedItems.length, (slow?.askedTotal ?? 0) - gone),
  };
  const lanes: Record<LaneKey, LaneRead> = { asked, ...fast.lanes };
  const versions = {} as Record<LaneKey, string>;
  for (const k of LANES) versions[k] = versionOf(lanes[k]);
  return {
    at: now,
    stamp,
    lanes,
    versions,
    moved: fast.moved,
    builders: fast.builders,
    strip: slow?.strip ?? null,
    asks: slow?.asks ?? {},
    figures: slow?.figures ?? null,
    idle: slow?.idle ?? null,
  };
}
