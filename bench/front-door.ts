/**
 * The front door's feed read (#3311): the signed-in home on a forge of two
 * thousand events, after a write so the feed phase is a cache miss. Its
 * budget is 25 ms. A wall-clock bound is not a test (it flakes on a busy
 * machine), so it lives here.
 *
 *   bun run bench/front-door.ts
 */

import { openIssue } from "../src/actions/issues.ts";
import { snappyFixture } from "./snappy.ts";

const BUDGET_MS = 25;
const ROUNDS = 15;

const f = await snappyFixture({ repos: 50, issuesPerRepo: 40 });
const get = async (): Promise<string> => {
  const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
  await res.arrayBuffer();
  return res.headers.get("server-timing") ?? "";
};
await get();
const times: number[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const opened = openIssue(f.app, f.owner, f.repos[0]!, { title: `A write the feed must read again ${i}` });
  if (!opened.ok) throw new Error(String(opened.error));
  const feed = (await get()).split(", ").find((p) => p.startsWith("feed;"));
  const m = /dur=([\d.]+)/.exec(feed ?? "");
  if (!m || feed?.includes("hit")) throw new Error(`feed was not a miss: ${feed}`);
  times.push(Number(m[1]));
}
await f.close();
times.sort((a, b) => a - b);
const p50 = times[Math.floor(times.length / 2)]!;
console.log(`feed read after a write: p50 ${p50.toFixed(1)} ms, max ${times.at(-1)!.toFixed(1)} ms (budget ${BUDGET_MS} ms)`);
if (p50 > BUDGET_MS) {
  console.error("over budget");
  process.exit(1);
}
