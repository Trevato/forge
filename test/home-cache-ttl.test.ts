/**
 * Home's KPI, panel and vitals answers are kept 60 s from when they were
 * computed, whatever is written since (#7624); the builders figure is read
 * fresh beside them, and the waiting line still misses on a write, because
 * the asks count must stay exact.
 */
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Answer } from "../src/boards/query.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import {
  cachedKpis,
  cachedPanel,
  cachedVitals,
  cachedWaiting,
  kpiCache,
  panelCache,
  setHomeClock,
  vitalsCache,
  waitingCache,
} from "../src/web/studio/home_cache.ts";
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
  for (const c of [kpiCache(app.db), panelCache(app.db), vitalsCache(app.db), waitingCache(app.db)]) c.clear();
});
afterEach(() => setHomeClock(undefined));

const write = (times: number): void => {
  for (let i = 0; i < times; i++) app.db.query("UPDATE repo SET description = ?1 WHERE id = ?2").run(`w${i}`, repo.id);
};

test("cachedKpis computes once across 50 writes, and again at 61 s", () => {
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
  expect(cachedKpis(app.db, now, forge).landedHours).not.toBe(first.landedHours);
  expect(cache.misses).toBe(m + 2);
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

test("a panel and the vitals are kept 60 s through writes, each by its own identity", () => {
  let a = 0;
  let b = 0;
  const answer = (n: number) => ({ n }) as unknown as Answer;
  const vitals = vitalsCache(app.db);
  const v = vitals.misses;
  cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a));
  cachedPanel(app.db, { board: "ops", title: "B" }, () => answer(++b));
  cachedVitals(app.db, now);
  write(50);
  cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a));
  cachedPanel(app.db, { board: "ops", title: "B" }, () => answer(++b));
  cachedVitals(app.db, now);
  expect([a, b, vitals.misses - v]).toEqual([1, 1, 1]);

  t += 61_000;
  cachedPanel(app.db, { board: "ops", title: "A" }, () => answer(++a));
  cachedVitals(app.db, now);
  expect([a, vitals.misses - v]).toEqual([2, 2]);
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
