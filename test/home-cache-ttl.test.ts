/**
 * Home's KPI, panel and vitals answers are kept 60 s from when they were
 * computed, whatever is written since (#7624); past 60 s the old answer is
 * still served at once while one refresh runs after the tick (#7625), up to
 * a 10 min ceiling; the builders figure is read fresh beside them, and the
 * waiting line still misses on a write, because the asks count must stay
 * exact.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Answer } from "../src/boards/query.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { takePhases, timePhase } from "../src/core/route_timing.ts";
import type { KpiPart } from "../src/flow/kpis.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";
import { cachedKpis, cachedPanel, cachedWaiting, HOME_STALE_CEILING_MS, kpiCache, panelCache, setHomeClock, waitingCache } from "../src/web/studio/home_cache.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";

quietLogs();

let dir: string;
let app: App;
let admin: User;
let repo: Repo;
let t = 1_000_000;
const forge = { ceilingUsd: null };
const now = new Date("2026-11-01T12:00:00Z");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-home-ttl-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(app, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  admin = a.value;
  const made = await createRepo(app, admin, { name: "engine", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
});
afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  t = 1_000_000;
  setHomeClock(() => t);
  for (const c of [kpiCache(app.db), panelCache(app.db), waitingCache(app.db)]) c.clear();
});
afterEach(async () => {
  // A refresh one test scheduled runs here, not in the next test.
  await new Promise((done) => setTimeout(done, 0));
  setHomeClock(undefined);
});

/** Let the refreshes scheduled with `setTimeout(0)` run. */
const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

const write = (times: number): void => {
  for (let i = 0; i < times; i++) app.db.query("UPDATE repo SET description = ?1 WHERE id = ?2").run(`w${i}`, repo.id);
};

test("cachedKpis computes once across 50 writes, and again after the tick past 61 s", async () => {
  const cache = kpiCache(app.db);
  const m = cache.misses;
  const first = cachedKpis(app.db, now, forge);
  write(50);
  expect(cachedKpis(app.db, now, forge).landedHours).toBe(first.landedHours);
  expect(cache.misses).toBe(m + 1);

  t += 59_000;
  cachedKpis(app.db, now, forge);
  expect(cache.misses).toBe(m + 1);

  t += 2_000;
  expect(cachedKpis(app.db, now, forge).landedHours).toBe(first.landedHours);
  expect(cache.misses).toBe(m + 1);
  await tick();
  expect(cachedKpis(app.db, now, forge).landedHours).not.toBe(first.landedHours);
});

test("the builders figure is read fresh on a hit, so it agrees with the idle reason beside it", () => {
  const cache = kpiCache(app.db);
  const m = cache.misses;
  expect(cachedKpis(app.db, now, forge).builders.running).toBe(0);
  const run = createRun(app.db, { repoId: repo.id, kind: "agent", actorId: admin.id, reason: "assigned" });
  claimRun(app.db, run.id);
  expect(cachedKpis(app.db, now, forge).builders.running).toBe(1);
  expect(cache.misses).toBe(m + 1);
});

test("a panel is kept 60 s through writes, by its own identity", async () => {
  let a = 0;
  let b = 0;
  const answer = (n: number) => ({ n }) as unknown as Answer;
  cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a));
  cachedPanel(app.db, { board: "ops", title: "B" }, () => answer(++b));
  write(50);
  cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a));
  cachedPanel(app.db, { board: "ops", title: "B" }, () => answer(++b));
  expect([a, b]).toEqual([1, 1]);

  t += 61_000;
  expect(cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a))).toEqual(answer(1));
  expect(a).toBe(1);
  await tick();
  expect([a, b]).toEqual([2, 1]);
  expect(cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a))).toEqual(answer(2));
});

test("past 60 s the old answer comes back without calling compute", () => {
  let n = 0;
  const compute = () => ({ n: ++n }) as unknown as Answer;
  cachedPanel(app.db, "p", compute);
  t += 61_000;
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 1 } as unknown as Answer);
  expect(n).toBe(1);
});

test("after the scheduled tick the next call returns the new answer", async () => {
  let n = 0;
  const compute = () => ({ n: ++n }) as unknown as Answer;
  cachedPanel(app.db, "p", compute);
  t += 61_000;
  cachedPanel(app.db, "p", compute);
  await tick();
  expect(n).toBe(2);
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 2 } as unknown as Answer);
  expect(n).toBe(2);
});

test("two stale calls in a row schedule one refresh", async () => {
  let n = 0;
  const compute = () => ({ n: ++n }) as unknown as Answer;
  cachedPanel(app.db, "p", compute);
  t += 61_000;
  cachedPanel(app.db, "p", compute);
  cachedPanel(app.db, "p", compute);
  await tick();
  await tick();
  expect(n).toBe(2);
});

test("a refresh that throws keeps the old answer and frees the key", async () => {
  let n = 0;
  let fail = true;
  const compute = () => {
    n++;
    if (fail) throw new Error("refresh failed");
    return { n } as unknown as Answer;
  };
  cachedPanel(app.db, "p", () => ({ n: 0 }) as unknown as Answer);
  t += 61_000;
  cachedPanel(app.db, "p", compute);
  await tick();
  expect(n).toBe(1);
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 0 } as unknown as Answer);
  fail = false;
  await tick();
  expect(n).toBe(2);
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 2 } as unknown as Answer);
});

test("only a cold start computes inline", () => {
  let n = 0;
  const compute = () => ({ n: ++n }) as unknown as Answer;
  expect(cachedPanel(app.db, "cold", compute)).toEqual({ n: 1 } as unknown as Answer);
  expect(n).toBe(1);
});

test("past the ceiling a stale answer is not served: the request computes inline", () => {
  let n = 0;
  const compute = () => ({ n: ++n }) as unknown as Answer;
  cachedPanel(app.db, "p", compute);
  t += HOME_STALE_CEILING_MS - 1;
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 1 } as unknown as Answer);
  t += 1;
  expect(cachedPanel(app.db, "p", compute)).toEqual({ n: 2 } as unknown as Answer);
  expect(n).toBe(2);
});

test("a refresh that throws is logged", async () => {
  const level = logLevel();
  setLogLevel("warn");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    cachedPanel(app.db, "p", () => ({ n: 0 }) as unknown as Answer);
    t += 61_000;
    cachedPanel(app.db, "p", () => {
      throw new Error("refresh failed");
    });
    await tick();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("home.refresh_failed");
  } finally {
    warn.mockRestore();
    setLogLevel(level);
  }
});

test("the Server-Timing kpis phase is a hit, warm or stale, running only the builders' read", async () => {
  // Work is counted through readKpis' own timer seam, not a clock or a patched
  // db.query (#7824): each part it runs is named once, and nothing else in the
  // process can add to the count.
  const kpis = (): { hit: boolean | undefined; parts: KpiPart[] } => {
    const parts: KpiPart[] = [];
    const count = <T>(name: KpiPart, fn: () => T): T => {
      parts.push(name);
      return fn();
    };
    const request = new Request("http://forge.test/");
    timePhase(request, "kpis", () => cachedKpis(app.db, now, forge, count), () => kpiCache(app.db));
    return { hit: takePhases(request).find((p) => p.name === "kpis")!.hit, parts };
  };
  const cold = kpis();
  const warm = kpis();
  t += 61_000;
  const stale = kpis();
  await tick();
  expect(cold.hit).toBeFalsy();
  expect(cold.parts.length).toBeGreaterThan(1);
  for (const phase of [warm, stale]) {
    expect(phase.hit).toBe(true);
    expect(phase.parts).toEqual(["kpis.builders"]);
  }
});

test("nothing is kept inside a transaction", () => {
  app.db.transaction(() => {
    cachedKpis(app.db, now, forge);
    cachedKpis(app.db, now, forge);
  })();
  expect(kpiCache(app.db).size).toBe(0);
});

test("the waiting line still misses on a write: the asks count stays exact", () => {
  let n = 0;
  const compute = () => ({ count: ++n, oldest: null, stale: [] });
  cachedWaiting(app.db, "u1", compute);
  cachedWaiting(app.db, "u1", compute);
  expect(n).toBe(1);
  write(1);
  cachedWaiting(app.db, "u1", compute);
  expect(n).toBe(2);
});
