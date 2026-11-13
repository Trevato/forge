/**
 * The new home's table (`web/pages/home_table.ts`): the same items as the
 * lanes, one row each, from the same picture (`lanes.ts`) a viewer may read.
 * Search, filters and sort are plain data over those rows, held in the URL so
 * a link is a view: `?view=table&lane=checks&state=stuck&q=retry&sort=age&dir=desc`.
 * Pure: it reads no clock and no database.
 */

import {
  itemTone,
  LANE_NAME,
  LANES,
  type HealthInput,
  type LaneItem,
  type LaneKey,
  type Viewing,
} from "./lanes.ts";

export const COLUMNS = [
  "app",
  "title",
  "lane",
  "state",
  "who",
  "time",
  "age",
] as const;
export type Column = (typeof COLUMNS)[number];

export const TONES = ["stuck", "waiting", "flowing"] as const;
export type RowTone = (typeof TONES)[number];

export interface TableQuery {
  readonly q: string;
  readonly lane: LaneKey | null;
  readonly app: string | null;
  readonly who: string | null;
  readonly tone: RowTone | null;
  readonly sort: Column;
  readonly dir: "asc" | "desc";
}

const SLUG = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The query a URL asks for: anything that is not one of the known values is no filter. */
export function parseTable(params: URLSearchParams): TableQuery {
  const app = params.get("app") ?? "";
  const who = params.get("who") ?? "";
  return {
    q: (params.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 100),
    lane: LANES.find((l) => l === params.get("lane")) ?? null,
    app: SLUG.test(app) ? app : null,
    who: NAME.test(who) ? who : null,
    tone: TONES.find((t) => t === params.get("state")) ?? null,
    sort: COLUMNS.find((c) => c === params.get("sort")) ?? "lane",
    dir: params.get("dir") === "desc" ? "desc" : "asc",
  };
}

/** The query string of a view: only what differs from the default is written. `change` replaces fields; null clears one. */
export function tableParams(q: TableQuery, change: Partial<{ [K in keyof TableQuery]: TableQuery[K] | null }> = {}): string {
  const at = { ...q, ...change } as { [K in keyof TableQuery]: TableQuery[K] | null };
  const p = new URLSearchParams();
  if (at.q) p.set("q", at.q);
  if (at.lane) p.set("lane", at.lane);
  if (at.app) p.set("app", at.app);
  if (at.who) p.set("who", at.who);
  if (at.tone) p.set("state", at.tone);
  if (at.sort && at.sort !== "lane") p.set("sort", at.sort);
  if (at.dir === "desc") p.set("dir", "desc");
  return p.toString();
}

/** The address of a view of the table. */
export function tableHref(q: TableQuery, change: Partial<{ [K in keyof TableQuery]: TableQuery[K] | null }> = {}): string {
  const rest = tableParams(q, change);
  return `/home?view=table${rest === "" ? "" : `&${rest}`}`;
}

export interface TableRow {
  readonly key: string;
  readonly lane: LaneKey;
  readonly laneName: string;
  /** `owner/name`. */
  readonly repo: string;
  /** The app's name: the repository without its owner. */
  readonly app: string;
  readonly number: number | null;
  readonly title: string;
  /** Where it is, as one sentence. */
  readonly hint: string;
  readonly tone: RowTone;
  readonly who: string;
  /** When it entered this lane. */
  readonly since: string;
  /** When the issue or pull was opened; null for a check of main and a release. */
  readonly born: string | null;
  readonly href: string;
  /** The issue or pull, for a bulk action; null where there is none to act on. */
  readonly issueId: string | null;
  readonly kind: LaneItem["kind"];
  /** What search matches, lowercase. */
  readonly haystack: string;
}

/** Every item of every lane a viewer may read, one row each, a change appearing once: in the lane furthest along. */
export function tableRows(viewing: Viewing, input: HealthInput): TableRow[] {
  const seen = new Set<string>();
  const out: TableRow[] = [];
  for (const lane of [...LANES].reverse())
    for (const i of viewing.lanes[lane].all) {
      if (seen.has(i.key)) continue;
      seen.add(i.key);
      const app = i.repo.split("/")[1] ?? i.repo;
      out.push({
        key: i.key,
        lane,
        laneName: LANE_NAME[lane],
        repo: i.repo,
        app,
        number: i.number,
        title: i.title,
        hint: i.hint,
        tone: itemTone(i, lane, input),
        who: i.who,
        since: i.since,
        born: i.born,
        href: i.href,
        issueId: i.issueId,
        kind: i.kind,
        haystack:
          `${i.repo} ${i.number === null ? "" : `#${i.number}`} ${i.title} ${i.hint} ${i.who} ${LANE_NAME[lane]}`.toLowerCase(),
      });
    }
  return out;
}

/** Rows that match the search (every word of it, anywhere) and the filters; `skip` leaves one filter out, for the counts a chip shows. */
export function filterRows(
  rows: readonly TableRow[],
  q: TableQuery,
  skip: "lane" | "tone" | "who" | "app" | null = null,
): TableRow[] {
  const words = q.q.toLowerCase().split(" ").filter(Boolean);
  return rows.filter(
    (r) =>
      words.every((w) => r.haystack.includes(w)) &&
      (skip === "lane" || q.lane === null || r.lane === q.lane) &&
      (skip === "tone" || q.tone === null || r.tone === q.tone) &&
      (skip === "who" || q.who === null || r.who === q.who) &&
      (skip === "app" || q.app === null || r.repo === q.app),
  );
}

const toneOrder = (t: RowTone): number => TONES.indexOf(t);

/** Sorted by the column, then by who has waited longest in the lane. */
export function sortRows(rows: readonly TableRow[], q: TableQuery): TableRow[] {
  const sign = q.dir === "desc" ? -1 : 1;
  const text = (a: string, b: string): number => a.localeCompare(b);
  const by = (a: TableRow, b: TableRow): number => {
    switch (q.sort) {
      case "app":
        return text(a.repo, b.repo) || (a.number ?? 0) - (b.number ?? 0);
      case "title":
        return text(a.title, b.title);
      case "lane":
        return LANES.indexOf(a.lane) - LANES.indexOf(b.lane);
      case "state":
        return toneOrder(a.tone) - toneOrder(b.tone) || text(a.hint, b.hint);
      case "who":
        return text(a.who, b.who);
      case "time":
        // A longer wait sorts as larger: ascending is the newest in the lane first.
        return Date.parse(b.since) - Date.parse(a.since);
      case "age":
        return Date.parse(b.born ?? b.since) - Date.parse(a.born ?? a.since);
    }
  };
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (x, y) =>
        sign * by(x.r, y.r) ||
        Date.parse(x.r.since) - Date.parse(y.r.since) ||
        x.i - y.i,
    )
    .map((x) => x.r);
}

export interface Chip {
  readonly label: string;
  readonly count: number;
  readonly on: boolean;
  readonly href: string;
}

export interface Facets {
  readonly lanes: readonly Chip[];
  readonly tones: readonly Chip[];
  readonly who: readonly Chip[];
  readonly apps: readonly Chip[];
}

const CHIP_MAX = 6;

/** The chips: each counts what the view would hold if it were chosen, and links to that view (chosen again, it clears). */
export function facets(rows: readonly TableRow[], q: TableQuery): Facets {
  const count = (
    skip: "lane" | "tone" | "who" | "app",
    pick: (r: TableRow) => boolean,
  ): number => filterRows(rows, q, skip).filter(pick).length;
  const top = (
    skip: "who" | "app",
    of: (r: TableRow) => string,
    chosen: string | null,
  ): string[] => {
    const tally = new Map<string, number>();
    for (const r of filterRows(rows, q, skip))
      if (of(r) !== "") tally.set(of(r), (tally.get(of(r)) ?? 0) + 1);
    const names = [...tally]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([n]) => n)
      .slice(0, CHIP_MAX);
    return chosen !== null && !names.includes(chosen)
      ? [...names, chosen]
      : names;
  };
  return {
    lanes: LANES.map((l) => ({
      label: LANE_NAME[l],
      count: count("lane", (r) => r.lane === l),
      on: q.lane === l,
      href: tableHref(q, { lane: q.lane === l ? null : l }),
    })),
    tones: TONES.map((t) => ({
      label: t === "stuck" ? "Stuck" : t === "waiting" ? "Waiting" : "Flowing",
      count: count("tone", (r) => r.tone === t),
      on: q.tone === t,
      href: tableHref(q, { tone: q.tone === t ? null : t }),
    })),
    who: top("who", (r) => r.who, q.who).map((w) => ({
      label: w,
      count: count("who", (r) => r.who === w),
      on: q.who === w,
      href: tableHref(q, { who: q.who === w ? null : w }),
    })),
    apps: top("app", (r) => r.repo, q.app).map((a) => ({
      label: a.split("/")[1] ?? a,
      count: count("app", (r) => r.repo === a),
      on: q.app === a,
      href: tableHref(q, { app: q.app === a ? null : a }),
    })),
  };
}
