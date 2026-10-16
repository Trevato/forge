import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import migration from "../src/core/migrations/20261016130000-usage-count.ts";
import { createUsageCounter, readUsage } from "../src/core/usage_count.ts";

const ev = {
  pattern: "/api/issues",
  method: "GET",
  status: 200,
  role: "user",
  surface: "api",
};

function fresh() {
  const db = new Database(":memory:");
  db.run(migration);
  return db;
}

test("three counts of one key are one row of 3 after a flush, none before", () => {
  const db = fresh();
  const c = createUsageCounter(db);
  c.count(ev);
  c.count({ ...ev, status: 204 });
  c.count(ev);
  expect(readUsage(db, "")).toEqual([]);
  c.flush();
  const rows = readUsage(db, "");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ n: 3, status: "2xx" });
  c.count(ev);
  c.stop();
  expect(readUsage(db, "")[0]!.n).toBe(4);
});

test("two hours make two rows", () => {
  const db = fresh();
  let t = new Date("2026-10-16T10:59:00Z");
  const c = createUsageCounter(db, () => t);
  c.count(ev);
  t = new Date("2026-10-16T11:00:00Z");
  c.count(ev);
  c.flush();
  expect(readUsage(db, "").map((r) => r.hour)).toEqual([
    "2026-10-16T10",
    "2026-10-16T11",
  ]);
  expect(readUsage(db, "2026-10-16T11")).toHaveLength(1);
});

test("a refused event writes nothing", () => {
  const db = fresh();
  const c = createUsageCounter(db);
  for (const bad of [
    { role: "root" },
    { surface: "ssh" },
    { method: "BREW" },
    { status: 199 },
    { status: 600 },
    { pattern: "" },
    { pattern: "x".repeat(201) },
  ])
    expect(() => c.count({ ...ev, ...bad })).toThrow();
  c.flush();
  expect(readUsage(db, "")).toEqual([]);
});

test("it flushes by itself after its delay", async () => {
  const db = fresh();
  const c = createUsageCounter(db, () => new Date(), 30);
  c.count(ev);
  expect(readUsage(db, "")).toEqual([]);
  await Bun.sleep(80);
  expect(readUsage(db, "")[0]!.n).toBe(1);
  c.stop();
});

test("500 pending keys flush without count running a query", async () => {
  const db = fresh();
  const c = createUsageCounter(db);
  for (let i = 0; i < 500; i++) c.count({ ...ev, pattern: `/p/${i}` });
  expect(readUsage(db, "")).toEqual([]);
  await Bun.sleep(20);
  expect(readUsage(db, "")).toHaveLength(500);
  c.stop();
});

test("a failed write keeps the counts, retries by itself and never throws from the timer", async () => {
  const db = fresh();
  const c = createUsageCounter(db, () => new Date(), 20);
  db.run("DROP TABLE usage_count");
  c.count(ev);
  c.count(ev);
  await Bun.sleep(60); // timer fires and fails, then retries; no uncaught throw
  expect(() => c.flush()).toThrow();
  db.run(migration);
  await Bun.sleep(60); // the rearmed timer writes the kept counts
  expect(readUsage(db, "")[0]!.n).toBe(2);
  c.count(ev);
  c.stop();
  expect(readUsage(db, "")[0]!.n).toBe(3);
});
