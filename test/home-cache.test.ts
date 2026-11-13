/**
 * The feed's pinned panels come from the cache docs/CACHING.md designs
 * (#2717): a warm look runs none of their reads, even after a write (#7624),
 * and the owner's panels never reach another viewer. The KPIs are not drawn
 * here any more: the home reads them off the request thread (`lanes_worker.ts`).
 */
import { forgetHome } from "../src/web/studio/home_last.ts";
import { freshHome } from "./helpers/home-fresh.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { pinPanel } from "../src/actions/board-pins.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { panelCache } from "../src/web/studio/home_cache.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

let f: SnappyFixture;
const feed = (cookie?: string): Promise<string> => freshHome(f.base, cookie, "/feed");

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

test("a warm feed does not read the panels again, even after a write", async () => {
  const a = await feed(f.ownerCookie);
  expect(a).toContain("<h2>Pin A</h2>");
  const panel = panelCache(f.app.db);
  const before = panel.misses;
  await feed(f.ownerCookie);
  expect(panel.misses).toBe(before);
  // The second look is a hit one layer in front of that cache (`home_last.ts`): the phase says so.
  const res = await fetch(`${f.base}/feed`, { headers: { cookie: f.ownerCookie } });
  await res.arrayBuffer();
  expect(res.headers.get("server-timing") ?? "").toMatch(/panels;dur=[\d.]+;desc="hit"/);

  f.app.db.query("UPDATE repo SET description = 'moved' WHERE id = ?1").run(f.repos[0]!.id);
  await feed(f.ownerCookie);
  expect(panel.misses).toBe(before);
});

test("the owner's panels never render for another viewer, warm or not", async () => {
  await feed(f.ownerCookie);
  for (const cookie of [f.peerCookie, undefined]) expect(await feed(cookie)).not.toContain("Pin A");
});

test("forgetting the feed's memory draws the panels again", async () => {
  await feed(f.ownerCookie);
  forgetHome(f.app.db);
  panelCache(f.app.db).clear();
  expect(await feed(f.ownerCookie)).toContain("<h2>Pin A</h2>");
});
