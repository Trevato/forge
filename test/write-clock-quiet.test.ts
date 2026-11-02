/**
 * Telemetry does not keep the caches cold (#7896): the rows a route timing,
 * a usage count, a flag read, a session's last-seen time, a home visit or a
 * page vital writes are left out of the write clock, while any other write
 * still moves it. And so a home read after a second of traffic is a hit.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createUsageCounter } from "../src/core/usage_count.ts";
import { makeFlags } from "../src/core/flags.ts";
import { sessionOf, createSession } from "../src/core/sessions.ts";
import { recordMemory } from "../src/boards/memory.ts";
import { record as recordRing } from "../src/boards/ring.ts";
import { createRouteTiming } from "../src/core/route_timing.ts";
import { noteVisit } from "../src/core/home_visit.ts";
import { quietly, writeStamp } from "../src/core/write_clock.ts";
import { recordVital } from "../src/web/measure.ts";
import { kpiCache } from "../src/web/studio/home_cache.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

test("a quiet write leaves the stamp; a loud one moves it", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (n INTEGER)");
  const before = writeStamp(db);
  quietly(db, () => db.run("INSERT INTO t VALUES (1)"));
  expect(writeStamp(db)).toBe(before);
  db.run("INSERT INTO t VALUES (2)");
  expect(writeStamp(db)).not.toBe(before);
});

test("a quiet write that rolls back is still left out", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE t (n INTEGER)");
  const before = writeStamp(db);
  expect(() =>
    db.transaction(() => {
      quietly(db, () => db.run("INSERT INTO t VALUES (1)"));
      throw new Error("no");
    })(),
  ).toThrow();
  expect(writeStamp(db)).toBe(before);
});

let f: SnappyFixture;
beforeAll(async () => {
  f = await snappyFixture({ repos: 2, issuesPerRepo: 2 });
}, 60_000);
afterAll(async () => {
  await f.close();
});

/** Every row of every table, so a writer's footprint can be named. */
function dump(db: Database): Map<string, string> {
  const out = new Map<string, string>();
  const names = db
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of names) out.set(name, JSON.stringify(db.query(`SELECT * FROM "${name}"`).all()));
  return out;
}

/** The tables no cached page is built from: the only ones a quiet writer may touch. */
const TELEMETRY = new Set([
  "route_timing", "usage_count", "flag_use", "session", "home_visit",
  "page_vital", "vital_salt", "memory_hour", "machine_sample",
]);

const flags = makeFlags({ probe: { why: "test", default: false, issue: 7896 } });

const writers: Record<string, () => void> = {
  "route timing": () => {
    const t = createRouteTiming(f.app.db);
    t.record("GET /probe", 3);
    t.flush();
    t.stop();
  },
  "usage count": () => {
    const c = createUsageCounter(f.app.db);
    c.count({ pattern: "GET /probe", method: "GET", status: 200, role: "anon", surface: "web" });
    c.flush();
    c.stop();
  },
  "flag read": () => {
    flags.flag("probe");
    flags.flush(f.app.db);
  },
  "session last-seen": () => {
    const { token } = createSession(f.app.db, f.owner.id);
    f.app.db.query("UPDATE session SET last_seen_at = NULL").run();
    stampBase = writeStamp(f.app.db);
    expect(sessionOf(f.app.db, token).ok).toBe(true);
  },
  "home visit": () => void noteVisit(f.app.db, f.owner.id, Date.now() + 3_600_000),
  "page vital": () => void recordVital(f.app.db, { path: "/", ttfb: 1, load: 2, lcp: 3, inp: 4, cls: 0 }, "/", "client", "agent"),
  "memory sample": () => recordMemory(f.app.db, 1e8, 5e7, Date.now()),
  "machine sample": () =>
    recordRing(f.app.db, [{ at: Date.now(), target: "forge", cpuCores: 1, memoryBytes: 1e8, load: 0.5 }], Date.now()),
};
let stampBase: string | undefined;

for (const [name, write] of Object.entries(writers))
  test(`the ${name} write leaves the clock, and touches only telemetry tables`, () => {
    const db = f.app.db;
    stampBase = writeStamp(db);
    const before = dump(db);
    write();
    const after = dump(db);
    const touched = [...after].filter(([t, rows]) => before.get(t) !== rows).map(([t]) => t);
    expect(touched.length).toBeGreaterThan(0);
    for (const t of touched) expect(TELEMETRY.has(t)).toBe(true);
    expect(writeStamp(db)).toBe(stampBase);
  });

test("a loud write still moves the clock", () => {
  const db = f.app.db;
  const before = writeStamp(db);
  db.query("INSERT INTO forge_setting (key, value, updated_by, updated_at) VALUES ('probe', '1', ?1, 'x')").run(f.owner.id);
  expect(writeStamp(db)).not.toBe(before);
});

test("a home read after telemetry flushed is a cache hit", async () => {
  await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } }).then((r) => r.text());
  const kpi = kpiCache(f.app.db);
  const misses = kpi.misses;
  writers["route timing"]!();
  writers["page vital"]!();
  await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } }).then((r) => r.text());
  expect(kpi.misses).toBe(misses);
});

test("the home's since-your-last-visit is read outside every cache", async () => {
  const src = await Bun.file(new URL("../src/web/studio/home_cache.ts", import.meta.url)).text();
  expect(src).not.toContain("home_visit");
  expect(src).not.toContain("lastVisit");
});
