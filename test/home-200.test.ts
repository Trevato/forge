/** #5806: the owner's home on a forge of 200 repositories and 100 open asks answers warm in within 300 ms, every slow phase named. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { waitingCache } from "../src/web/studio/home_cache.ts";
import { baselineMs, expectBudget } from "./helpers/budget.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";

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

async function look(): Promise<{ ms: number; phases: { name: string; ms: number }[] }> {
  const t = performance.now();
  const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
  await res.arrayBuffer();
  const ms = performance.now() - t;
  const phases = (res.headers.get("server-timing") ?? "")
    .split(", ")
    .map((p) => ({ name: p.split(";")[0]!, ms: Number(/dur=([\d.]+)/.exec(p)?.[1] ?? 0) }));
  return { ms, phases };
}

test("the second look at home as the owner is within its budget, and every phase over 20 ms is named", async () => {
  await look();
  const warm = await look();
  const slow = warm.phases.filter((p) => p.name !== "app" && p.ms > 20);
  console.log(`home warm ${warm.ms.toFixed(0)} ms:`, warm.phases.map((p) => `${p.name} ${p.ms}`).join(", "));
  expectBudget(warm.ms, { ms: 300, against: await baselineMs(f.base) });
  // The page's own total is the sum of named phases: nothing over 20 ms hides in "app" alone.
  // Every phase home.ts and the feed time: one missing here fails as a plain expect, which the gate's budget retry never re-runs.
  const known = new Set(["app", "spawned", "steps", "session", "repos", "asked", "kpis", "vitals", "waiting", "panels", "feed", "settled", "visit", "since", "render"]);
  for (const p of slow) expect(known.has(p.name)).toBe(true);
  const total = warm.phases.find((p) => p.name === "app")!.ms;
  const named = warm.phases.filter((p) => p.name !== "app").reduce((s, p) => s + p.ms, 0);
  expectBudget(total - named, { ms: 20, against: await baselineMs(f.base) });
});

const waiting = async (): Promise<number> => {
  const text = await (await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } })).text();
  return Number(/(\d+) waiting on you/.exec(text)?.[1] ?? 0);
};

test("the waiting line is a hit on the second look and a write puts it back", async () => {
  const first = await waiting();
  expect(first).toBeGreaterThan(0);
  const before = waitingCache(f.app.db).hits;
  expect(await waiting()).toBe(first);
  expect(waitingCache(f.app.db).hits).toBeGreaterThan(before);
  // Every ask is put down in one write: the line is gone at once, not in 30 seconds.
  f.app.db.query("UPDATE issue SET assignee_id = NULL").run();
  expect(await waiting()).toBe(0);
});
