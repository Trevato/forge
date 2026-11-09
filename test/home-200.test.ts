/** #5806: the owner's home on a forge of 200 repositories and 100 open asks is read in a bounded number of statements warm, every slow phase named. */
import { freshHome } from "./helpers/home-fresh.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let f: SnappyFixture;

beforeAll(async () => {
  f = await snappyFixture({ repos: 200, issuesPerRepo: 1 });
  // An ask is something assigned to the owner; half the repositories hold one.
  for (const repo of f.repos.slice(0, 100)) {
    const issue = openIssue(f.app, f.owner, repo, { title: "Yours to decide" });
    if (!issue.ok) throw new Error(String(issue.error));
    const done = assignIssue(f.app, f.owner, repo, issue.value, f.owner);
    if (!done.ok) throw new Error(String(done.error));
  }
}, 600_000);
afterAll(async () => {
  await f.close();
});

async function look(): Promise<{ phases: { name: string; ms: number }[] }> {
  const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
  await res.arrayBuffer();
  const phases = requestTiming(res)
    .split(", ")
    .map((p) => ({ name: p.split(";")[0]!, ms: Number(/dur=([\d.]+)/.exec(p)?.[1] ?? 0) }));
  return { phases };
}

test("the second look at home as the owner costs a bounded number of statements, and every phase over 20 ms is named", async () => {
  await look();
  const warm = await look();
  const slow = warm.phases.filter((p) => p.name !== "app" && p.ms > 20);
  // Counted, not timed (#7824): 200 repositories and 100 asks are read in batches, not one statement each.
  expectWork(await statements(f.app.db, async () => void (await look())), { max: 70 });
  // The page's own total is the sum of named phases: nothing over 20 ms hides in "app" alone.
  // Every phase home.ts and the feed time: one missing here fails as a plain expect, which the gate's budget retry never re-runs.
  const known = new Set(["app", "spawned", "steps", "session", "repos", "asked", "kpis", "vitals", "waiting", "panels", "feed", "settled", "visit", "since", "moving", "render"]);
  for (const p of slow) expect(known.has(p.name)).toBe(true);
});

const waiting = async (): Promise<number> => {
  const text = await freshHome(f.base, f.ownerCookie, "/feed");
  return Number(/(\d+) waiting on you/.exec(text)?.[1] ?? 0);
};

test("the waiting line is a hit on the second look and a write puts it back", async () => {
  const first = await waiting();
  expect(first).toBeGreaterThan(0);
  expect(await waiting()).toBe(first);
  const timing = (await fetch(`${f.base}/feed`, { headers: { cookie: f.ownerCookie } })).headers.get("server-timing") ?? "";
  expect(timing).toMatch(/waiting;dur=[\d.]+;desc="hit"/);
  // Every ask is put down in one write: the line is gone at once, not in 30 seconds.
  f.app.db.query("UPDATE issue SET assignee_id = NULL").run();
  expect(await waiting()).toBe(0);
});
