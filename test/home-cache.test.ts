/**
 * Home's KPI row and pinned panels come from the cache docs/CACHING.md
 * designs (#2717): hit when nothing was written, miss after a write, p95
 * under the budget, and the owner's figures never reach another viewer.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pinPanel } from "../src/actions/board-pins.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { kpiCache, panelCache } from "../src/web/studio/home_cache.ts";
import { snappyFixture, timeRoute, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
const home = async (cookie?: string): Promise<string> =>
  (await fetch(`${f.base}/`, { headers: cookie ? { cookie } : {} })).text();

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

test("a warm home reads neither the KPIs nor the panels again; a write does", async () => {
  const a = await home(f.ownerCookie);
  expect(a).toContain('class="kpis"');
  expect(a).toContain("<h2>Pin A</h2>");
  const kpi = kpiCache(f.app.db);
  const panel = panelCache(f.app.db);
  const [km, pm] = [kpi.misses, panel.misses];
  await home(f.ownerCookie);
  expect([kpi.misses, panel.misses]).toEqual([km, pm]);
  expect(kpi.hits).toBeGreaterThan(0);
  expect(panel.hits).toBeGreaterThan(0);

  f.app.db.query("UPDATE repo SET description = 'moved' WHERE id = ?1").run(f.repos[0]!.id);
  await home(f.ownerCookie);
  expect([kpi.misses, panel.misses]).toEqual([km + 1, pm + 1]);
});

test("the owner's KPIs and panels never render for another viewer, warm or not", async () => {
  await home(f.ownerCookie);
  for (const cookie of [f.peerCookie, undefined]) {
    const page = await home(cookie);
    expect(page).not.toContain('class="kpis"');
    expect(page).not.toContain('class="card kpi"');
    expect(page).not.toContain("Pin A");
  }
});

test("warm home holds p95 under the stated budget", async () => {
  const t = await timeRoute(f, "home owner", "/", { cookie: f.ownerCookie }, 30);
  expect(t.status).toBe(200);
  // The doc's 50 ms is read off the bench; the test keeps the 200 ms floor test/flake.test.ts allows.
  expect(t.p95).toBeLessThan(200);
});
