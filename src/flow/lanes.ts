/**
 * The pipeline as six lanes of items, for the new home (`web/pages/home_flow.ts`):
 * asked, building, checks, review, landing and live, each with the few items
 * that are in it now and the lane's own health in words. `pipeline.ts` counts
 * the stages; this names what is in them.
 *
 * One picture per write: the six reads run once after anything is written
 * (`writeStamp`, at most 30 s old otherwise), and every lane, every viewer
 * and every open tab is answered from it. A viewer's own reading is that
 * picture filtered to the repositories they may read, so a private
 * repository's work is never named to anyone else. Plain data out, no HTML.
 */

import type { Database } from "bun:sqlite";
import { canRead, getReposByIds, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { writeStamp } from "../core/write_clock.ts";
import { queueStatus } from "../checks/queue.ts";
import { shortTitle } from "./moving.ts";
import { readPipeline, span, type PipelineStage } from "./pipeline.ts";

export const LANES = [
  "asked",
  "building",
  "checks",
  "review",
  "landing",
  "live",
] as const;
export type LaneKey = (typeof LANES)[number];

/** The name a lane wears on the page. */
export const LANE_NAME: Record<LaneKey, string> = {
  asked: "Asked",
  building: "Building",
  checks: "Checks",
  review: "Review",
  landing: "Landing",
  live: "Live",
};

/** What a lane holds, in one plain line: no word of the forge's own without its meaning. */
export const LANE_HOLDS: Record<LaneKey, string> = {
  asked: "Things you asked for that are ready and waiting for a builder.",
  building: "Crew members writing the change right now.",
  checks: "Tests running on a change before anyone reviews it.",
  review: "A second crew member reading the change before it may land.",
  landing:
    "Approved changes waiting to be merged, and merged ones on their way to the live app.",
  live: "What went live in the last 24 hours.",
};

/** Items a lane lists; the rest are counted. */
export const LANE_ITEMS = 6;
/** Rows read per lane before a viewer's access filters them. */
const SCAN = 40;
/** A picture is never older than this, writes or not. */
const MAX_AGE_MS = 30_000;
/** A builder that has not been heard from for this long has gone quiet. */
export const QUIET_MS = 10 * 60_000;
/** An item that waits this long for a free worker is stuck, not queued. */
export const STUCK_WAIT_MS = 30 * 60_000;
/** A check that has run this long is not running tests any more. */
const CHECK_LONG_MS = 45 * 60_000;
/** Approved changes waiting on a person past this are named as stuck. */
const LAND_STUCK_MS = 48 * 3_600_000;

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
  /** Pulls this deploy carried beyond the first, for a live item. */
  readonly more: number;
}

export interface LaneRead {
  readonly items: readonly LaneItem[];
  /** Everything in the lane, not only what was read. */
  readonly total: number;
}

export interface LanePicture {
  readonly at: number;
  readonly lanes: Readonly<Record<LaneKey, LaneRead>>;
  readonly stages: readonly PipelineStage[];
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
  branch: string | null;
  beat: string | null;
  carried: number | null;
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
  for (const r of [...rows]
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
    more: 0,
    ...over,
  };
}

/** Issues the crew could start now, newest first: the readiness rules of `pipeline.ts` over the 200 newest open issues, never the whole table (the count is `pipeline.ts`'s own, kept off the thread). */
function askedRows(db: Database): Raw[] {
  return db
    .query<Raw, [number]>(
      `SELECT i.id, i.repo_id, i.number, 'issue' AS kind, i.title, i.sealed, u.username AS who, i.created_at AS since,
              'ready' AS state, NULL AS reason, NULL AS attempt, NULL AS env, NULL AS branch, NULL AS beat, NULL AS carried, 0 AS total
         FROM (SELECT * FROM issue WHERE kind = 'issue' AND state = 'open' ORDER BY created_at DESC LIMIT 200) i
         JOIN repo r ON r.id = i.repo_id LEFT JOIN user u ON u.id = i.author_id
        WHERE r.autonomy != 'off'
          AND (r.direction_issue_id IS NULL OR r.direction_issue_id != i.id)
          AND NOT EXISTS (SELECT 1 FROM issue_dependency d JOIN issue b ON b.id = d.blocked_by_id
                           WHERE d.issue_id = i.id AND b.state = 'open')
          AND NOT EXISTS (SELECT 1 FROM run x WHERE x.issue_id = i.id AND x.kind = 'agent'
                           AND x.state IN ('queued','running'))
        ORDER BY i.created_at DESC LIMIT ?1`,
    )
    .all(SCAN);
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
              x.state, x.reason, x.attempt, x.env, x.branch, x.heartbeat_at AS beat, NULL AS carried,
              COUNT(*) OVER () AS total
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
              'approved' AS state, NULL AS reason, NULL AS attempt, NULL AS env, NULL AS branch, NULL AS beat, NULL AS carried,
              COUNT(*) OVER () AS total
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
              'merged' AS state, NULL AS reason, NULL AS attempt, NULL AS env, NULL AS branch, NULL AS beat, NULL AS carried,
              COUNT(*) OVER () AS total
         FROM pull p JOIN issue i ON i.id = p.issue_id JOIN repo r ON r.id = i.repo_id
         JOIN app a ON a.repo_id = r.id LEFT JOIN user u ON u.id = p.merged_by
        WHERE p.merged_at >= ?1 AND p.base_branch = r.default_branch
          AND NOT EXISTS (SELECT 1 FROM run d WHERE d.repo_id = r.id AND d.kind = 'deploy'
                           AND d.env = 'production' AND d.created_at >= p.merged_at)
        ORDER BY p.merged_at DESC LIMIT ?2`,
    )
    .all(weekAgo, SCAN);
}

/**
 * Production deploys: the ones going live now and the ones that went live in
 * the last 24 hours, newest first. A deploy is keyed by the first change it
 * carried, so the tile that sat in Landing is the tile that arrives here.
 */
function deployRows(db: Database, dayAgo: string): Raw[] {
  return db
    .query<Raw, [string, number]>(
      `SELECT COALESCE((SELECT dp.issue_id FROM deploy_pull dp WHERE dp.run_id = x.id ORDER BY dp.pull_number LIMIT 1), x.id) AS id,
              x.repo_id,
              (SELECT dp.pull_number FROM deploy_pull dp WHERE dp.run_id = x.id ORDER BY dp.pull_number LIMIT 1) AS number,
              'deploy' AS kind,
              (SELECT i.title FROM deploy_pull dp JOIN issue i ON i.id = dp.issue_id WHERE dp.run_id = x.id ORDER BY dp.pull_number LIMIT 1) AS title,
              0 AS sealed, u.username AS who,
              COALESCE(x.serving_at, x.started_at, x.created_at) AS since,
              x.state, NULL AS reason, NULL AS attempt, x.env, NULL AS branch, NULL AS beat,
              (SELECT COUNT(*) FROM deploy_pull dp WHERE dp.run_id = x.id) AS carried,
              COUNT(*) OVER () AS total
         FROM run x LEFT JOIN user u ON u.id = x.actor_id
        WHERE x.kind = 'deploy' AND x.env = 'production'
          AND (x.serving_at >= ?1 OR x.state IN ('queued','running'))
        ORDER BY COALESCE(x.serving_at, x.started_at, x.created_at) DESC LIMIT ?2`,
    )
    .all(dayAgo, SCAN);
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
      item(r, {
        state: "active",
        hint: "Landed: going live next.",
      }),
    ),
  ];
  return { items, total: (approved[0]?.total ?? 0) + (merged[0]?.total ?? 0) };
}

function live(rows: readonly Raw[]): LaneRead {
  const items = rows.map((r) => {
    const going = r.state === "queued" || r.state === "running";
    const n = r.carried ?? 0;
    return item(r, {
      state: going ? "active" : "done",
      hint: going ? "Going live now." : "Serving now.",
      more: Math.max(0, n - 1),
      ...(r.title === null || r.title === ""
        ? { title: "A new version of the app" }
        : {}),
    });
  });
  // One tile per change: a deploy that carried none is keyed by itself.
  return { items, total: rows[0]?.total ?? 0 };
}

/** Drop the sibling rows whose key repeats (two deploys can carry the same first pull, a pull can have two checks): the first stays. */
function unique(read: LaneRead): LaneRead {
  const seen = new Set<string>();
  return {
    total: read.total,
    items: read.items.filter((i) =>
      seen.has(i.key) ? false : (seen.add(i.key), true),
    ),
  };
}

/** Read the six lanes now: `LANES.length + 2` statements and the pipeline's own cached counts. */
export function readLanes(db: Database, now = new Date()): LanePicture {
  const iso = now.toISOString();
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const day = new Date(now.getTime() - 86_400_000).toISOString();
  const asked = askedRows(db);
  const lanes: Record<LaneKey, LaneRead> = {
    asked: {
      items: asked.map((r) =>
        item(r, {
          state: "waiting",
          hint: "Ready.",
        }),
      ),
      total: asked.length,
    },
    building: unique(building(runRows(db, "agent", "x.reason != 'review'", iso))),
    checks: unique(checks(runRows(db, "check", "1 = 1", iso))),
    review: unique(review(runRows(db, "agent", "x.reason = 'review'", iso))),
    landing: landing(approvedRows(db), mergedRows(db, week)),
    live: unique(live(deployRows(db, day))),
  };
  return { at: now.getTime(), lanes, stages: readPipeline(db, now) };
}

const kept = new WeakMap<
  Database,
  { stamp: string; at: number; picture: LanePicture }
>();

/**
 * The picture, from memory while nothing has been written: the same rows
 * serve every lane, every viewer and every tab until the write clock moves.
 */
export function lanePicture(db: Database, now = Date.now()): LanePicture {
  const stamp = writeStamp(db);
  if (stamp === undefined) return readLanes(db, new Date(now));
  const had = kept.get(db);
  if (had !== undefined && had.stamp === stamp && now - had.at < MAX_AGE_MS)
    return had.picture;
  const picture = readLanes(db, new Date(now));
  kept.set(db, { stamp, at: now, picture });
  return picture;
}

/** One lane as one viewer may read it: the picture's items in repositories they can read, never a sealed one. */
export interface LaneView {
  readonly key: LaneKey;
  readonly items: readonly (LaneItem & {
    readonly repo: string;
    readonly href: string;
  })[];
  /** Items in the lane, before the page's own list limit. */
  readonly total: number;
  /** Items hidden by the viewer's access or the app filter are not counted here. */
  readonly more: number;
}

export interface Viewing {
  readonly lanes: Readonly<Record<LaneKey, LaneView>>;
  /** `owner/name` of every repository with something in the pipeline, for the filter. */
  readonly repos: readonly string[];
  readonly stages: readonly PipelineStage[];
}

/** The picture filtered for `viewer`, and to `only` (an `owner/name`) when the filter is set. */
export function viewFor(
  db: Database,
  viewer: User,
  picture: LanePicture,
  only: string | null = null,
): Viewing {
  const ids = new Set<string>();
  for (const k of LANES)
    for (const i of picture.lanes[k].items) ids.add(i.repoId);
  const repos = getReposByIds(db, [...ids]);
  const readable = new Map<string, Repo | undefined>();
  const repoOf = (id: string): Repo | undefined => {
    if (!readable.has(id)) {
      const r = repos.get(id);
      readable.set(
        id,
        r !== undefined && canRead(db, r, viewer) ? r : undefined,
      );
    }
    return readable.get(id);
  };
  const seen = new Set<string>();
  const lanes = {} as Record<LaneKey, LaneView>;
  for (const k of LANES) {
    const read = picture.lanes[k];
    const shown: (LaneItem & { repo: string; href: string })[] = [];
    let visible = 0;
    for (const i of read.items) {
      const repo = repoOf(i.repoId);
      if (repo === undefined || i.sealed) continue;
      const full = `${repo.ownerName}/${repo.name}`;
      seen.add(full);
      if (only !== null && full !== only) continue;
      visible++;
      const base = `/${repo.ownerName}/${repo.name}`;
      const href =
        i.number === null
          ? base
          : `${base}/${i.kind === "pull" || i.kind === "deploy" ? "pulls" : "issues"}/${i.number}`;
      shown.push({
        ...i,
        repo: full,
        href: i.kind === "main" ? `${base}/runs` : href,
      });
    }
    // An admin reads every repository, so the lane's true total is theirs; anyone else counts what they could see.
    const total =
      viewer.isAdmin && only === null ? Math.max(read.total, visible) : visible;
    lanes[k] = {
      key: k,
      items: shown.slice(0, LANE_ITEMS),
      total,
      more: Math.max(0, total - Math.min(shown.length, LANE_ITEMS)),
    };
  }
  return { lanes, repos: [...seen].sort(), stages: picture.stages };
}

export type Tone = "quiet" | "flowing" | "waiting" | "stuck";

export interface Health {
  readonly tone: Tone;
  /** Full sentences, plain. */
  readonly words: string;
  /** How long the oldest waiting item has waited, or null. */
  readonly oldest: string | null;
}

export interface HealthInput {
  readonly now: number;
  /** Builders running of their slots: names what an asked item waits on. */
  readonly builders: { readonly running: number; readonly slots: number };
}

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;
const age = (since: string, now: number): number =>
  Math.max(0, now - Date.parse(since));

/** The lane's own health: flowing, waiting on something named, or stuck, with the oldest item's age. */
export function laneHealth(
  view: LaneView,
  stage: PipelineStage | undefined,
  input: HealthInput,
): Health {
  const { now } = input;
  const items = view.items;
  const waiting = items.filter((i) => i.state === "waiting");
  const active = items.filter((i) => i.state === "active");
  const oldestItem = waiting.reduce<(typeof items)[number] | undefined>(
    (o, i) => (o === undefined || i.since < o.since ? i : o),
    undefined,
  );
  const oldestMs = oldestItem === undefined ? 0 : age(oldestItem.since, now);
  const oldest = oldestItem === undefined ? null : span(oldestMs);
  const quiet: Health = {
    tone: "quiet",
    words: "Nothing here right now.",
    oldest: null,
  };
  switch (view.key) {
    case "asked": {
      if (view.total === 0)
        return { ...quiet, words: "Nothing is waiting to be built." };
      const busy =
        input.builders.slots > 0 &&
        input.builders.running >= input.builders.slots;
      const sinceReady =
        stage?.oldestWaiting != null
          ? span(now - Date.parse(stage.oldestWaiting))
          : oldest;
      const on = busy
        ? `every builder is busy (${input.builders.running} of ${input.builders.slots})`
        : "the crew has not picked it up yet";
      const stuck =
        stage?.oldestWaiting != null &&
        now - Date.parse(stage.oldestWaiting) > 24 * 3_600_000 &&
        !busy;
      return {
        tone: stuck ? "stuck" : "waiting",
        words: `${plural(view.total, "ask is", "asks are")} ready and ${on}. The oldest has been ready for ${sinceReady ?? "a while"}.`,
        oldest: sinceReady,
      };
    }
    case "building": {
      if (view.total === 0)
        return { ...quiet, words: "No one is building right now." };
      const gone = active.filter(
        (i) => i.beat !== null && now - Date.parse(i.beat) > QUIET_MS,
      );
      if (gone.length > 0)
        return {
          tone: "stuck",
          words: `${plural(gone.length, "builder has", "builders have")} gone quiet for over ${span(QUIET_MS)}: they may be stuck.`,
          oldest,
        };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS)
        return {
          tone: "stuck",
          words: `A build has waited ${oldest} for a builder: the crew is not starting it.`,
          oldest,
        };
      if (waiting.length > 0)
        return {
          tone: "waiting",
          words: `${plural(active.length, "builder is", "builders are")} working and ${waiting.length} more ${waiting.length === 1 ? "waits" : "wait"} for a free one.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(active.length, "builder is", "builders are")} working, nothing is waiting.`,
        oldest: null,
      };
    }
    case "checks": {
      if (view.total === 0)
        return { ...quiet, words: "No tests are running or waiting." };
      const long = active.filter(
        (i) => now - Date.parse(i.since) > CHECK_LONG_MS,
      );
      if (long.length > 0)
        return {
          tone: "stuck",
          words: `A check has been running for over ${span(CHECK_LONG_MS)}, far longer than a check takes.`,
          oldest,
        };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS)
        return {
          tone: "stuck",
          words: `A check has waited ${oldest} for a free test runner.`,
          oldest,
        };
      if (waiting.length > 0)
        return {
          tone: "waiting",
          words: `${plural(active.length, "check is", "checks are")} running and ${waiting.length} ${waiting.length === 1 ? "waits" : "wait"} for a free test runner.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(active.length, "check is", "checks are")} running, none waiting.`,
        oldest: null,
      };
    }
    case "review": {
      if (view.total === 0)
        return { ...quiet, words: "No change is being reviewed." };
      if (waiting.length > 0 && oldestMs > STUCK_WAIT_MS)
        return {
          tone: "stuck",
          words: `A change has waited ${oldest} for a reviewer.`,
          oldest,
        };
      if (waiting.length > 0)
        return {
          tone: "waiting",
          words: `${plural(active.length, "reviewer is", "reviewers are")} reading and ${waiting.length} ${waiting.length === 1 ? "change waits" : "changes wait"} for one.`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(active.length, "change is", "changes are")} being read by a reviewer.`,
        oldest: null,
      };
    }
    case "landing": {
      if (view.total === 0)
        return { ...quiet, words: "Nothing is waiting to land." };
      const queued = queueStatus().reduce((n, s) => n + s.queued + s.gating, 0);
      const via =
        queued > 0
          ? ` The merge queue is testing ${plural(queued, "change", "changes")} together before they land.`
          : "";
      if (waiting.length > 0 && oldestMs > LAND_STUCK_MS)
        return {
          tone: "stuck",
          words: `${plural(waiting.length, "approved change has", "approved changes have")} waited for you for ${oldest}.${via}`,
          oldest,
        };
      if (waiting.length > 0)
        return {
          tone: "waiting",
          words: `${plural(waiting.length, "approved change waits", "approved changes wait")} for you to land ${waiting.length === 1 ? "it" : "them"}; the oldest has waited ${oldest}.${via}`,
          oldest,
        };
      return {
        tone: "flowing",
        words: `${plural(active.length, "change is", "changes are")} merged and on the way to the live app.${via}`,
        oldest: null,
      };
    }
    case "live": {
      if (view.total === 0)
        return {
          ...quiet,
          words: "Nothing has gone live in the last 24 hours.",
        };
      const going = active.length;
      const newest = items.find((i) => i.state === "done");
      const last =
        newest === undefined
          ? ""
          : ` The newest went live ${span(age(newest.since, now))} ago.`;
      return {
        tone: "flowing",
        words: `${going > 0 ? `${plural(going, "version is", "versions are")} going live. ` : ""}${plural(view.total, "release", "releases")} in the last 24 hours.${last}`,
        oldest: null,
      };
    }
  }
}
