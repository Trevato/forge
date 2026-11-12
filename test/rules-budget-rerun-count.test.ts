/** Budget tests under load (#7560): re-run green three times in a week files a headroom issue with its p95. */
import { expect, test } from "bun:test";
import { duty } from "../src/maintain/duties/rule_watcher.ts";
import { budgetReruns, fileHeadroom, headroomTitle, p95 } from "../src/rules/budget_rerun.ts";
import { failMs, recordFlakes } from "../src/checks/flake.ts";
import { rulesWorld } from "./helpers/rules-app.ts";
import { seedFlake } from "./helpers/rules-seed.ts";

const w = rulesWorld();
const now = Date.now();
const BUDGET = "feed > the feed answers in under 50" + " ms p95 budget";

test("p95 is the nearest rank; the failed attempt's time is read from its line", () => {
  expect(p95([])).toBeUndefined();
  expect(p95([10, 20, 30, 40, 50, 60, 70, 80, 90, 100])).toBe(100);
  expect(p95([5])).toBe(5);
  expect(failMs("(fail) a > b [123.45ms]")).toBe(123);
  expect(failMs("(fail) a > b [1.5s]")).toBe(1500);
  expect(failMs("(fail) a > b")).toBeUndefined();
});

test("two re-run passes file nothing; the third files one issue with the measured p95", () => {
  seedFlake(w.app.db, w.repoId, BUDGET, "test/feed.test.ts", now - 3000, 60);
  seedFlake(w.app.db, w.repoId, BUDGET, "test/feed.test.ts", now - 2000, 90);
  seedFlake(w.app.db, w.repoId, "feed > ordinary flake", "test/feed.test.ts", now - 2000);
  seedFlake(w.app.db, w.repoId, "feed > ordinary flake", "test/feed.test.ts", now - 1000);
  seedFlake(w.app.db, w.repoId, "feed > ordinary flake", "test/feed.test.ts", now - 500);
  expect(fileHeadroom(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
  seedFlake(w.app.db, w.repoId, BUDGET, "test/feed.test.ts", now - 1000, 120);
  expect(budgetReruns(w.app.db, now).map((b) => [b.test, b.passes, b.p95Ms])).toEqual([[BUDGET, 3, 120]]);
  expect(fileHeadroom(w.app.db, w.app.bus, w.repos, now)).toHaveLength(1);
  const body = w.app.db.query<{ body: string }, [string]>("SELECT body FROM issue WHERE title = ?1").get(headroomTitle(BUDGET))!.body;
  expect(body).toContain("p95 of the failed attempts: 120 ms");
  expect(body).toContain("#7354");
  expect(fileHeadroom(w.app.db, w.app.bus, w.repos, now)).toEqual([]);
});

test("recordFlakes keeps the time the failed attempt took", () => {
  recordFlakes(w.app.db, w.app.bus, w.repos.get(w.repoId)!, [{ file: "test/t.test.ts", name: "t > timed", ms: 77 }], { runId: "r1", commit: "abc" });
  expect(w.app.db.query<{ ms: number }, []>("SELECT ms FROM check_flake WHERE test = 't > timed'").get()!.ms).toBe(77);
});

test("the duty runs all four reads and reports each finding on a probe", async () => {
  const result = await duty.run({ db: w.app.db, bus: w.app.bus, now: new Date(now) });
  expect(result.findings.some((f) => f.summary.includes("budget test"))).toBe(true);
  expect(result.findings.some((f) => f.summary.startsWith("flake trend "))).toBe(true);
  for (const f of result.findings) expect(f.probe?.what).toBeTruthy();
});

test("a name that only mentions a time is not a budget test", async () => {
  const { BUDGET_NAME } = await import("../src/rules/budget_rerun.ts");
  expect(BUDGET_NAME.test("the feed answers within the latency budget")).toBe(true);
  expect(BUDGET_NAME.test(["the feed answers in", "under 50", "ms"].join(" "))).toBe(true);
  expect(BUDGET_NAME.test("p95 holds")).toBe(true);
  expect(BUDGET_NAME.test("retries after 500 ms of silence")).toBe(false);
  expect(BUDGET_NAME.test("the page answers in json")).toBe(false);
});
