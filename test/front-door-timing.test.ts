/** The front door's Server-Timing names every phase, and a heavy feed reads fast (#3311). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOrg } from "../src/core/orgs.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { openIssue } from "../src/actions/issues.ts";
import { affinityFor } from "../src/feed/affinity.ts";
import { readFeed } from "../src/feed/feed.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { rank } from "../src/feed/rank.ts";

let f: SnappyFixture;

// 50 repositories, 40 issues each: two thousand events.
beforeAll(async () => {
  f = await snappyFixture({ repos: 50, issuesPerRepo: 40 });
}, 300_000);
afterAll(async () => {
  await f.close();
});

const parts = (res: Response): string[] => (res.headers.get("server-timing") ?? "").split(", ");

test("the signed-in home names its session, reads and render and a cold feed read", async () => {
  const get = async (): Promise<Response> => {
    const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
    await res.arrayBuffer();
    return res;
  };
  // Warm the statements, then write: the feed read that follows is a miss.
  await get();
  const opened = openIssue(f.app, f.owner, f.repos[0]!, { title: "A write the feed must read again" });
  if (!opened.ok) throw new Error(String(opened.error));
  const res = await get();
  const all = parts(res);
  const names = all.map((p) => p.split(";")[0]!);
  for (const n of ["session", "steps", "repos", "kpis", "panels", "feed", "render"])
    expect(names.filter((x) => x === n).length).toBe(1);
  // A miss is a bare `feed;dur=…`: a hit would carry `desc="hit"`.
  expect(all.find((p) => p.startsWith("feed;"))).toMatch(/^feed;dur=\d+(\.\d+)?$/);
  // The next read of the same feed is the cache's.
  const again = parts(await get());
  expect(again.find((p) => p.startsWith("feed;"))).toContain('desc="hit"');
});

test("a spawned forge's lean home names spawned and steps once each, and reads no feed", async () => {
  const file = join(f.dataDir, "parent.json");
  const org = createOrg(f.app.db, "lean-child", f.owner.id);
  if (!org.ok) throw new Error(String(org.error));
  await writeFile(file, JSON.stringify({ org: "lean-child" }));
  try {
    const res = await fetch(`${f.base}/`, { headers: { cookie: f.ownerCookie } });
    await res.arrayBuffer();
    const names = parts(res).map((p) => p.split(";")[0]!);
    for (const n of ["spawned", "steps"]) expect(names.filter((x) => x === n).length).toBe(1);
    expect(names).not.toContain("feed");
  } finally {
    await rm(file, { force: true });
  }
});

test("placing only the page leaves the order of the whole ranking untouched", () => {
  const now = Date.now();
  const candidates = candidatesFor(f.app.db, f.owner, now, undefined, true);
  const aff = affinityFor(f.app.db, f.owner, now);
  const whole = rank(candidates, aff, now);
  expect(whole.length).toBeGreaterThan(60);
  expect(rank(candidates, aff, now, 51)).toEqual(whole.slice(0, 51));
  const page = readFeed(f.app.db, f.owner, { limit: 50, now });
  expect(page.items).toEqual(whole.slice(0, 50));
  expect(page.next_cursor).not.toBeNull();
});
