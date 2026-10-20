/**
 * An app's p75 load per day (#3239): oldest first, `null` for a silent day,
 * drawn with a gap on the settings page and in words when there is nothing.
 */
import { expect, test } from "bun:test";
import { loadP75Days, loadTrend, trendLine, appVitals } from "../src/apps/vitals.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { appVisitorsView } from "../src/web/pages/settings.ts";
import type { AppVitals } from "../src/apps/vitals.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const DAY = 86_400_000;
const none: AppVitals = { today: 0, week: 0, ttfbP75: undefined, loadP75: undefined, lcpP75: undefined, inpP75: undefined, clsP75: undefined, loadDays: [] };

function seeded() {
  const db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x')");
  db.run("INSERT INTO repo (id, owner_id, name) VALUES ('r1','u1','one')");
  db.run("INSERT INTO app (id, repo_id, slug, access) VALUES ('a1','r1','one','public')");
  const put = db.prepare("INSERT INTO app_vital (app_id, day, at, visitor, load) VALUES (?, ?, 0, ?, ?)");
  // Days 1, 2 and 4 of a 4 day window; day 3 is silent.
  const day = (back: number) => new Date(NOW - back * DAY).toISOString().slice(0, 10);
  [100, 200, 300, 400].forEach((l, i) => put.run("a1", day(3), `v${i}`, l));
  put.run("a1", day(2), "v0", 50);
  put.run("a1", day(0), "v0", 80);
  put.run("a1", day(0), "v1", 120);
  put.run("other", day(1), "v0", 999);
  return db;
}

test("loadP75Days is oldest first with null for the silent day", () => {
  const db = seeded();
  expect(loadP75Days(db, "a1", NOW, 4)).toEqual([300, 50, null, 120]);
  const thirty = loadP75Days(db, "a1", NOW);
  expect(thirty).toHaveLength(30);
  expect(thirty.slice(26)).toEqual([300, 50, null, 120]);
  expect(thirty.slice(0, 26).every((v) => v === null)).toBe(true);
});

test("the settings card breaks the line at the silent day", () => {
  const db = seeded();
  const out = String(appVisitorsView({ ...none, loadDays: loadP75Days(db, "a1", NOW, 4) }));
  expect(out).toContain("p75 load each day over the last 30 days");
  expect(out.match(/<polyline|<circle/g)).toHaveLength(2);
  expect(out).not.toContain("No load reports");
});

test("no reports in 30 days says so in words, with no svg", () => {
  const out = String(appVisitorsView({ ...none, loadDays: loadP75Days(seeded(), "nobody", NOW) }));
  expect(out).toContain("No load reports in the last 30 days");
  expect(out).not.toContain("kpi-spark");
});

test("the day query uses the app/day index", () => {
  const db = seeded();
  const plan = db
    .query("EXPLAIN QUERY PLAN SELECT day, load FROM app_vital WHERE app_id = ? AND day >= ? AND load IS NOT NULL")
    .all("a1", "2026-09-01")
    .map((r) => JSON.stringify(r))
    .join(" ");
  expect(plan).toContain("app_vital_app_day");
});

test("the series rides on appVitals, so the API and terminal carry it", () => {
  const v = appVitals(seeded(), "a1", NOW);
  expect(v.loadDays).toHaveLength(30);
  expect(v.loadDays.slice(26)).toEqual([300, 50, null, 120]);
});

test("the label names the latest day and the range", () => {
  const out = String(appVisitorsView({ ...none, loadDays: [800, null, 2100, 1200, null] }));
  expect(out).toContain("latest 1.2 s, range 800 ms to 2.1 s");
});

test("the terminal trend is blocks with a dot for a silent day", () => {
  expect(loadTrend([100, null, 800])).toBe("▂·█");
  expect(loadTrend([null, null])).toBe("");
  expect(trendLine([800, null, 2100])).toContain("800 ms–2.1 s");
  expect(trendLine([null])).toBe("");
});
