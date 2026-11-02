/**
 * Home's KPI row and pinned panels come from the cache docs/CACHING.md
 * designs (#2717): a hit within 60 s whatever was written (#7624), a warm
 * hit that runs none of their reads, and the owner's figures never reach
 * another viewer.
 */
import { forgetHome } from "../src/web/studio/home_last.ts";
import { freshHome } from "./helpers/home-fresh.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pinPanel } from "../src/actions/board-pins.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { writeStamp } from "../src/core/write_clock.ts";
import { kpiCache, panelCache } from "../src/web/studio/home_cache.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
/** Home and the feed page, which together hold what home was: the figures, then the panels and the timeline. */
const home = async (cookie?: string): Promise<string> => (await freshHome(f.base, cookie)) + (await freshHome(f.base, cookie, "/feed"));
/** Both pages' answers: the worst status and every phase either named. */
async function both(cookie: string): Promise<{ status: number; timing: string }> {
  const answers = [];
  for (const path of ["/", "/feed"]) {
    const res = await fetch(`${f.base}${path}`, { headers: { cookie } });
    await res.arrayBuffer();
    answers.push(res);
  }
  return { status: Math.max(...answers.map((r) => r.status)), timing: answers.map((r) => r.headers.get("server-timing") ?? "").join(", ") };
}

beforeAll(async () => {
  f = await snappyFixture();
  const w = await writeBoard(f.app, f.owner, "ops", {
    title: "Ops",
    range: "all",
    refresh: "off",
    panels: [{ title: "Pin A", chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 }],
  });
  if (!w.ok) throw new Error(JSON.stringify(w.error));
  const p = await pinPanel(f.app, f.owner, "ops", "Pin A");
  if (!p.ok) throw new Error(p.error);
}, 120_000);
afterAll(async () => {
  await f.close();
});

test("a warm home reads neither the KPIs nor the panels again, even after a write", async () => {
  const a = await home(f.ownerCookie);
  expect(a).toContain('class="stats kpi-row mb"');
  expect(a).toContain("<h2>Pin A</h2>");
  const kpi = kpiCache(f.app.db);
  const panel = panelCache(f.app.db);
  const [km, pm] = [kpi.misses, panel.misses];
  await home(f.ownerCookie);
  expect([kpi.misses, panel.misses]).toEqual([km, pm]);
  // The second look is a hit one layer in front of those caches (`home_last.ts`): both phases say so.
  const { timing } = await both(f.ownerCookie);
  expect(timing).toMatch(/kpis;dur=[\d.]+;desc="hit"/);
  expect(timing).toMatch(/panels;dur=[\d.]+;desc="hit"/);

  f.app.db.query("UPDATE repo SET description = 'moved' WHERE id = ?1").run(f.repos[0]!.id);
  await home(f.ownerCookie);
  expect([kpi.misses, panel.misses]).toEqual([km, pm]);
});

test("the owner's KPIs and panels never render for another viewer, warm or not", async () => {
  await home(f.ownerCookie);
  for (const cookie of [f.peerCookie, undefined]) {
    const page = await home(cookie);
    expect(page).not.toContain('class="stats kpi-row mb"');
    expect(page).not.toContain('class="stat"');
    expect(page).not.toContain("Pin A");
  }
});

/** The `kpis` and `panels` phases of one response, and whether each was a hit. */
const phases = (header: string | null): Record<string, boolean> =>
  Object.fromEntries(
    (header ?? "")
      .split(", ")
      .filter((p) => p.startsWith("kpis;") || p.startsWith("panels;"))
      .map((p) => [p.slice(0, p.indexOf(";")), p.endsWith(';desc="hit"')]),
  );

interface Counted {
  readonly status: number;
  readonly hits: Record<string, boolean>;
  /** How many times it ran each statement, by SQL text. */
  readonly ran: ReadonlyMap<string, number>;
  /** The write clock before and after it: a write in between is a correct miss. */
  readonly before: string | undefined;
  readonly after: string | undefined;
}

/** One owner home: its status, its `kpis`/`panels` hits and the statements it ran. */
async function counted(): Promise<Counted> {
  const before = writeStamp(f.app.db);
  f.counter.reset();
  const res = await both(f.ownerCookie);
  const ran = new Map(f.counter.top(10_000).map((s) => [s.sql, s.times]));
  return { status: res.status, hits: phases(res.timing), ran, before, after: writeStamp(f.app.db) };
}

/**
 * Nothing was written from the start of the request before `c` to its end:
 * every entry `c` reads was stored at the clock it reads at. (A write inside
 * the request before, after its KPI phase, leaves the KPIs stale and the
 * panels fresh, and the next request misses one of them, rightly.)
 */
const still = (c: Counted, previous: Counted): boolean =>
  c.before !== undefined && c.after === c.before && previous.before === c.before;

/** Request until one ran with nothing written since the request before it: the warm page. */
async function warmed(): Promise<Counted> {
  let previous = await counted();
  for (let i = 0; i < 10; i++) {
    const c = await counted();
    if (still(c, previous) && c.hits.kpis && c.hits.panels) return c;
    previous = c;
  }
  throw new Error("home never warmed: every request missed the KPI or panel cache");
}

// The budget is what the cached code spends, not the page's wall clock (#5237):
// a warm hit runs none of the KPI or panel reads, on any machine. The 200 ms
// bound this replaces timed the feed and the machine's load; and on a loaded
// machine a 0.4 ms hit and a 4 ms miss overlap, so time cannot tell them apart.
test("warm home holds p95 under the stated budget", async () => {
  const warm = await warmed();
  expect(warm.status).toBe(200);

  // What a miss of both runs that the warm page does not, with the feed still warm.
  forgetHome(f.app.db);
  kpiCache(f.app.db).clear();
  panelCache(f.app.db).clear();
  const missed = await counted();
  expect(missed.hits).toEqual({ kpis: false, panels: false });
  // Reads only: a route-timing flush that lands inside this one request (its INSERTs, PRAGMAs,
  // total_changes) is a write any request may carry, not the cache missing.
  const missOnly = [...missed.ran.keys()].filter(
    (sql) => !warm.ran.has(sql) && /^\s*SELECT\b/i.test(sql) && !sql.includes("total_changes()"),
  );
  // The KPI reads (eight on this fixture) and the pinned panel's own query.
  expect(missOnly.length).toBeGreaterThan(5);
  expect(missOnly).toContain('SELECT "kind" AS "group", COUNT(*) AS "value" FROM "run" GROUP BY 1 ORDER BY 1 LIMIT 1000');

  // Every warm request, not 95 in 100, is a hit of both and runs none of
  // them. A request a write came near (the route-timing flush, a session's
  // last-seen) may miss, rightly; most must not have.
  let previous = await warmed();
  let judged = 0;
  for (let i = 0; i < 30; i++) {
    const t = await counted();
    const quiet = still(t, previous);
    previous = t;
    if (!quiet) continue;
    judged++;
    expect(t.status).toBe(200);
    expect(t.hits).toEqual({ kpis: true, panels: true });
    expect(missOnly.filter((sql) => t.ran.has(sql))).toEqual([]);
  }
  expect(judged).toBeGreaterThanOrEqual(20);
});
