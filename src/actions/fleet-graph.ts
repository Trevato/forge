/**
 * The fleet graph: a selection of repositories' spend and runs over time,
 * as plain data — the last 24 hours by UTC hour and the last 14 days by UTC
 * day. The page (`web/pages/fleet-graph.ts`), its CSV and the API route all
 * answer from here, so they never disagree.
 *
 * Read from the usage ledger (`core/usage.ts`): a run is counted in the
 * bucket it *ended* in, at the provider's reported cost in US dollars. The
 * newest bucket is the current hour or day, still filling.
 *
 * Spend is the owner's own fact (`canSeeOwnerFacts` is write access), so a
 * selection is narrowed to the repositories the viewer may write. A name
 * that is missing and a name that is not theirs are dropped alike and only
 * counted together (`hidden`), so the count never says which.
 */

import type { App } from "../app.ts";
import {
  getRepo,
  getReposByIds,
  writableRepoIds,
  type Repo,
} from "../core/repos.ts";
import {
  reposWithUsage,
  usageBuckets,
  type UsageUnit,
} from "../core/usage.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

export type FleetWindowName = "24h" | "14d";

/** Each window: its bucket width and how many buckets, the newest last. */
export const FLEET_WINDOWS: Readonly<
  Record<FleetWindowName, { unit: UsageUnit; count: number; ms: number }>
> = {
  "24h": { unit: "hour", count: 24, ms: 3_600_000 },
  "14d": { unit: "day", count: 14, ms: 86_400_000 },
};

/** At most this many repositories in one selection's request. */
export const FLEET_GRAPH_MAX_REPOS = 100;
/**
 * At most this many lines in the legend: a ninth colour is one nobody can
 * tell from the other eight, so past eight the smallest spenders share one
 * series, "N others", and the table still lists every repository.
 */
export const FLEET_GRAPH_MAX_SERIES = 8;

export interface FleetSeries {
  /** `owner/name`, or `N others` for the folded tail. */
  readonly label: string;
  /** Every repository summed into this series, as `owner/name`. */
  readonly repos: readonly string[];
}

/** Figures indexed like `FleetGraph.series`. */
export interface FleetFigures {
  readonly runs: readonly number[];
  readonly failed: readonly number[];
  /** US dollars, the provider's reported cost. */
  readonly costUsd: readonly number[];
}

export interface FleetBucket extends FleetFigures {
  /** The bucket's first instant (ISO 8601, UTC). */
  readonly start: string;
}

export interface FleetWindow {
  readonly name: FleetWindowName;
  readonly unit: UsageUnit;
  /** The first bucket's start; the window covers [since, until). */
  readonly since: string;
  /** The end of the newest bucket, which is still filling. */
  readonly until: string;
  readonly buckets: readonly FleetBucket[];
  /** Per series, over the whole window. */
  readonly totals: FleetFigures;
}

/** One repository's own totals, for the table beside the chart. */
export interface FleetRepoRow {
  readonly repo: string;
  /** The index into `series` this repository is drawn in. */
  readonly series: number;
  readonly day: { readonly runs: number; readonly failed: number; readonly costUsd: number };
  readonly fortnight: { readonly runs: number; readonly failed: number; readonly costUsd: number };
}

export interface FleetGraph {
  /** When this was read (ISO 8601, UTC). */
  readonly at: string;
  /** The selection as asked: the names given, or `null` for the default. */
  readonly asked: readonly string[] | null;
  /** Names asked for that are not shown: missing or not the viewer's to see. */
  readonly hidden: number;
  readonly series: readonly FleetSeries[];
  /** The 24-hour window, then the 14-day one. */
  readonly windows: readonly [FleetWindow, FleetWindow];
  /** Every repository shown, most spent over 14 days first. */
  readonly repos: readonly FleetRepoRow[];
}

/** `owner/name`: each part starts with a letter, digit or underscore. */
const NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/**
 * The selection from a request: each `repo` value is `owner/name`; space-
 * or comma-separated lists are accepted too. Absent is `null` — the
 * default selection. Anything malformed or past the cap is a refusal, not
 * a silent trim, because a graph of less than was asked looks like an answer.
 */
export function fleetSelection(
  values: readonly string[],
): Result<string[] | null, string> {
  const names = values
    .flatMap((v) => v.split(/[\s,]+/))
    .filter((v) => v !== "");
  if (names.length === 0) return ok(null);
  if (names.length > FLEET_GRAPH_MAX_REPOS)
    return err(`at most ${FLEET_GRAPH_MAX_REPOS} repositories in one graph`);
  for (const n of names)
    if (!NAME.test(n)) return err(`"${n.slice(0, 40)}" is not owner/name`);
  return ok([...new Set(names.map((n) => n.toLowerCase()))]);
}

/** The start of the bucket holding `now`, then the window's first bucket. */
export function windowBounds(
  name: FleetWindowName,
  now: Date,
): { since: Date; until: Date; starts: Date[] } {
  const { ms, count } = FLEET_WINDOWS[name];
  // Hours and UTC days are both whole multiples of the epoch's ms, so
  // flooring the epoch time is flooring to the hour or the UTC midnight.
  const current = Math.floor(now.getTime() / ms) * ms;
  const first = current - (count - 1) * ms;
  const starts = Array.from({ length: count }, (_, i) => new Date(first + i * ms));
  return { since: new Date(first), until: new Date(current + ms), starts };
}

const fullName = (r: Repo): string => `${r.ownerName}/${r.name}`;

/**
 * The graph for a selection of names (`null` is the default: every
 * repository the viewer may write that spent anything in the last 14 days).
 */
export function readFleetGraph(
  app: App,
  user: User,
  asked: readonly string[] | null,
  now: Date = new Date(),
): FleetGraph {
  const db = app.db;
  const fortnight = windowBounds("14d", now);
  let candidates: Repo[];
  if (asked === null) {
    candidates = [
      ...getReposByIds(db, reposWithUsage(db, fortnight.since.toISOString())).values(),
    ];
  } else {
    candidates = [];
    for (const n of asked) {
      const [owner, name] = n.split("/") as [string, string];
      const repo = getRepo(db, owner, name);
      if (repo !== undefined) candidates.push(repo);
    }
  }
  const writable = writableRepoIds(
    db,
    user,
    candidates.map((r) => r.id),
  );
  const repos = candidates.filter((r) => writable.has(r.id));
  return fleetGraphFor(app, repos, asked, asked === null ? 0 : asked.length - repos.length, now);
}

/**
 * The graph for repositories already resolved and already allowed — the
 * seam the fleet table hands its selection through. Callers must have
 * narrowed `repos` to what the viewer may see spend for.
 */
export function fleetGraphFor(
  app: App,
  repos: readonly Repo[],
  asked: readonly string[] | null,
  hidden: number,
  now: Date = new Date(),
): FleetGraph {
  const ids = repos.map((r) => r.id);
  const read = (name: FleetWindowName) => {
    const bounds = windowBounds(name, now);
    const rows = usageBuckets(
      app.db,
      ids,
      bounds.since.toISOString(),
      FLEET_WINDOWS[name].unit,
    );
    return { bounds, rows };
  };
  const day = read("24h");
  const fortnight = read("14d");

  // Each repository's own totals, then the order: most spent over 14 days,
  // then most runs, then by name, so the order is stable for equal rows.
  type Sum = { runs: number; failed: number; costUsd: number };
  const zero = (): Sum => ({ runs: 0, failed: 0, costUsd: 0 });
  const own = new Map<string, { day: Sum; fortnight: Sum }>(
    ids.map((id) => [id, { day: zero(), fortnight: zero() }]),
  );
  for (const [rows, key] of [
    [day.rows, "day"],
    [fortnight.rows, "fortnight"],
  ] as const)
    for (const r of rows) {
      const s = own.get(r.repoId)?.[key];
      if (s === undefined) continue;
      s.runs += r.runs;
      s.failed += r.failed;
      s.costUsd += r.costUsd;
    }
  const ranked = [...repos].sort((a, b) => {
    const x = own.get(a.id)!.fortnight;
    const y = own.get(b.id)!.fortnight;
    return (
      y.costUsd - x.costUsd ||
      y.runs - x.runs ||
      fullName(a).localeCompare(fullName(b))
    );
  });

  // Series: one per repository up to the cap; past it, the last one is
  // the rest folded together.
  const folds = ranked.length > FLEET_GRAPH_MAX_SERIES;
  const named = folds ? FLEET_GRAPH_MAX_SERIES - 1 : ranked.length;
  const seriesOf = new Map<string, number>();
  ranked.forEach((r, i) => seriesOf.set(r.id, Math.min(i, named)));
  const series: FleetSeries[] = ranked
    .slice(0, named)
    .map((r) => ({ label: fullName(r), repos: [fullName(r)] }));
  if (folds) {
    const rest = ranked.slice(named).map(fullName);
    series.push({ label: `${rest.length} others`, repos: rest });
  }

  const window = (
    name: FleetWindowName,
    w: typeof day,
  ): FleetWindow => {
    const n = series.length;
    const index = new Map(
      w.bounds.starts.map((s, i) => [
        s.toISOString().slice(0, name === "24h" ? 13 : 10),
        i,
      ]),
    );
    const buckets = w.bounds.starts.map((s) => ({
      start: s.toISOString(),
      runs: new Array<number>(n).fill(0),
      failed: new Array<number>(n).fill(0),
      costUsd: new Array<number>(n).fill(0),
    }));
    for (const r of w.rows) {
      const b = buckets[index.get(r.bucket) ?? -1];
      const s = seriesOf.get(r.repoId);
      if (b === undefined || s === undefined) continue;
      b.runs[s]! += r.runs;
      b.failed[s]! += r.failed;
      b.costUsd[s]! += r.costUsd;
    }
    const total = (k: "runs" | "failed" | "costUsd") =>
      series.map((_, s) => buckets.reduce((sum, b) => sum + b[k][s]!, 0));
    return {
      name,
      unit: FLEET_WINDOWS[name].unit,
      since: w.bounds.since.toISOString(),
      until: w.bounds.until.toISOString(),
      buckets,
      totals: {
        runs: total("runs"),
        failed: total("failed"),
        costUsd: total("costUsd"),
      },
    };
  };

  return {
    at: now.toISOString(),
    asked,
    hidden: Math.max(hidden, 0),
    series,
    windows: [window("24h", day), window("14d", fortnight)],
    repos: ranked.map((r) => ({
      repo: fullName(r),
      series: seriesOf.get(r.id)!,
      day: own.get(r.id)!.day,
      fortnight: own.get(r.id)!.fortnight,
    })),
  };
}
