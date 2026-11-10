/** A stall no request ran across names the background job that was running (#10834). */

import { expect, test } from "bun:test";
import { createJobWatch, during } from "../src/perf/jobs.ts";
import { loopWatch } from "../src/perf/live.ts";
import { createLoopWatch, NO_REQUEST, stallLine } from "../src/perf/loop.ts";

const block = (ms: number): void => {
  const until = performance.now() + ms;
  while (performance.now() < until) {}
};

test("a job that blocks the loop 300 ms is named in the tally and the stall line", () => {
  const jobs = createJobWatch();
  const w = createLoopWatch(250, jobs.across);
  jobs.during("sweep", () => block(300));
  const at = performance.now();
  const stall = w.stalled(310, at)!;
  expect(stall.routes).toEqual([]);
  expect(stall.jobs).toEqual(["sweep"]);
  expect(stallLine(stall)).toContain("jobs sweep");
  const tally = w.tally(at);
  expect(tally.total).toEqual([{ route: "job:sweep", ms: 310, count: 1 }]);
  expect(tally.hour.map((r) => r.route)).toEqual(["job:sweep"]);
});

test("an async job is named while it awaits only when no job blocked across the stall", async () => {
  let t = 0;
  const jobs = createJobWatch(() => t);
  let done!: () => void;
  const body = jobs.during("lane", () => {
    t = 10; // the synchronous slice, up to the first await
    return new Promise<void>((r) => (done = r));
  });
  t = 1_000;
  expect(jobs.across(0, 5)).toEqual(["lane"]);
  // Nothing blocked across [500, 1000]: the awaiting lane is the lead.
  expect(jobs.across(500, 1_000)).toEqual(["lane"]);
  // A job that blocks while the lane awaits is the one named; the lane is not.
  jobs.during("sweep", () => { t = 1_400; });
  expect(jobs.across(1_100, 1_400)).toEqual(["sweep"]);
  t = 2_000;
  done();
  await body;
  t = 5_000;
  expect(jobs.across(1_500, 5_000)).toEqual(["lane"]);
  expect(jobs.across(2_001, 6_000)).toEqual([]);
});

test("a loop stall while a job awaits and another blocks is tallied to the blocker only", async () => {
  const jobs = createJobWatch();
  const w = createLoopWatch(250, jobs.across);
  let done!: () => void;
  const lane = jobs.during("lane", () => new Promise<void>((r) => (done = r)));
  const from = performance.now();
  jobs.during("sweep", () => block(300));
  const at = performance.now();
  const stall = w.stalled(at - from, at)!;
  expect(stall.jobs).toEqual(["sweep"]);
  expect(w.tally(at).total.map((r) => r.route)).toEqual(["job:sweep"]);
  done();
  await lane;
});

test("the process's loop watch reads the process's job watch", () => {
  const before = loopWatch.tally(performance.now()).total.find((r) => r.route === "job:wired-test")?.count ?? 0;
  during("wired-test", () => block(300));
  const at = performance.now();
  loopWatch.stalled(300, at);
  const after = loopWatch.tally(at).total.find((r) => r.route === "job:wired-test");
  expect(after?.count).toBe(before + 1);
});

test("a job that throws still ends, and the throw reaches the caller", () => {
  let t = 0;
  const jobs = createJobWatch(() => t);
  expect(() => jobs.during("bad", () => { t = 10; throw new Error("no"); })).toThrow("no");
  expect(jobs.across(20, 30)).toEqual([]);
  expect(jobs.across(5, 30)).toEqual(["bad"]);
});

test("a request across the stall is blamed, not the job", () => {
  let t = 0;
  const jobs = createJobWatch(() => t);
  const w = createLoopWatch(250, jobs.across);
  jobs.during("sweep", () => { t = 400; });
  w.finished("/boards", 0, 400);
  const stall = w.stalled(400, 400)!;
  expect(stall.routes).toEqual(["/boards"]);
  expect(w.tally(400).total.map((r) => r.route)).toEqual(["/boards"]);
});

test("an idle stall with no request and no job is still none", () => {
  let t = 0;
  const jobs = createJobWatch(() => t);
  const w = createLoopWatch(250, jobs.across);
  jobs.during("early", () => { t = 10; });
  t = 5_000;
  const stall = w.stalled(300, 5_000)!;
  expect(stall.jobs).toEqual([]);
  expect(stallLine(stall)).toBe("event loop blocked 300 ms; running then: no request");
  expect(w.tally(5_000).total).toEqual([{ route: NO_REQUEST, ms: 300, count: 1 }]);
});
