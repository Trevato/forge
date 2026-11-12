/** The flake trend (#7560): ordered by gate minutes delayed; the worst three get issues, once. */
import { expect, test } from "bun:test";
import { fileWorst, flakeTrend, trendLines, weekOf } from "../src/rules/flake_trend.ts";
import { rulesWorld } from "./helpers/rules-app.ts";
import { seedFlake, seedGate } from "./helpers/rules-seed.ts";

const w = rulesWorld();
const now = Date.now();

test("the list is ordered by wasted gate minutes, not by count", () => {
  // Many flakes in short gates, few in long ones.
  for (let i = 0; i < 4; i++) seedFlake(w.app.db, w.repoId, "busy > cheap", "test/cheap.test.ts", now - i * 1000, null, seedGate(w.app.db, w.repoId, [], [], now - i * 1000, 0.25));
  for (let i = 0; i < 2; i++) seedFlake(w.app.db, w.repoId, "slow > costly", "test/costly.test.ts", now - i * 1000, null, seedGate(w.app.db, w.repoId, [], [], now - i * 1000, 30));
  seedFlake(w.app.db, w.repoId, "mid > one", "test/mid.test.ts", now, null, seedGate(w.app.db, w.repoId, [], [], now, 12));
  seedFlake(w.app.db, w.repoId, "tiny > one", "test/tiny.test.ts", now, null, seedGate(w.app.db, w.repoId, [], [], now, 2));
  const list = flakeTrend(w.app.db, now);
  expect(list.map((t) => t.test)).toEqual(["slow > costly", "mid > one", "tiny > one", "busy > cheap"]);
  expect(list[0]).toMatchObject({ count: 2, minutes: 60 });
  expect(trendLines(list)[0]).toBe("slow > costly ×2, 60 min (alice/rules)");
});

test("the worst three get one issue each, with no quarantine; a repeat files none; the fourth gets none", () => {
  const list = flakeTrend(w.app.db, now);
  expect(fileWorst(w.app.db, w.app.bus, w.repos, list)).toHaveLength(3);
  expect(w.titles()).toEqual(expect.arrayContaining(["Flaky test: slow > costly", "Flaky test: mid > one", "Flaky test: tiny > one"]));
  expect(w.titles()).not.toContain("Flaky test: busy > cheap");
  expect(fileWorst(w.app.db, w.app.bus, w.repos, list)).toEqual([]);
  const body = w.app.db.query<{ body: string }, []>("SELECT body FROM issue WHERE title = 'Flaky test: slow > costly'").get()!.body;
  expect(body).toContain("quarantine is not allowed");
  expect(body).toContain("60 minutes");
});

test("the week is labelled by its Monday", () => {
  expect(weekOf(Date.parse("2026-11-11T10:00:00Z"))).toBe("2026-11-09");
  expect(weekOf(Date.parse("2026-11-15T23:59:00Z"))).toBe("2026-11-09");
  expect(weekOf(Date.parse("2026-11-16T00:00:00Z"))).toBe("2026-11-16");
});

test("the trend is said on the first run of a week, and its probe is the real query", async () => {
  const { flakeWeek } = await import("../src/rules/watch.ts");
  const { FLAKE_TREND_SQL } = await import("../src/rules/flake_trend.ts");
  const watch = { db: w.app.db, bus: w.app.bus, repos: w.repos, now: new Date(now) };
  const monday = Date.parse(weekOf(now));
  const first = flakeWeek(watch, monday - 1000);
  expect(first.findings).toHaveLength(1);
  expect(first.findings[0]!.probe).toMatchObject({ what: FLAKE_TREND_SQL });
  expect(() => w.app.db.query(FLAKE_TREND_SQL).all("2000-01-01T00:00:00Z", 5)).not.toThrow();
  expect(flakeWeek(watch, monday + 1000).findings).toEqual([]);
});
