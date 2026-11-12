/** The front door's Server-Timing names every phase, and a heavy feed reads fast (#3311). */
import { forgetHome } from "../src/web/studio/home_last.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createOrg } from "../src/core/orgs.ts";
import { snappyFixture, type SnappyFixture } from "../bench/snappy.ts";
import { createUser } from "../src/core/users.ts";
import { openIssue } from "../src/actions/issues.ts";
import { affinityFor } from "../src/feed/affinity.ts";
import { readFeed } from "../src/feed/feed.ts";
import { foldBursts } from "../src/feed/fold.ts";
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
    const res = await fetch(`${f.base}/feed`, { headers: { cookie: f.ownerCookie } });
    await res.arrayBuffer();
    return res;
  };
  // Warm the statements, then write: the feed read that follows is a miss.
  await get();
  const opened = openIssue(f.app, f.owner, f.repos[0]!, { title: "A write the feed must read again" });
  if (!opened.ok) throw new Error(String(opened.error));
  forgetHome(f.app.db);
  const res = await get();
  const all = parts(res);
  const names = all.map((p) => p.split(";")[0]!);
  for (const n of ["session", "repos", "panels", "feed", "render"])
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

test("placing only the page leaves the order of the whole ranking untouched", async () => {
  // The feed folds one author's bursts, so the whole ranking needs many authors
  // with one issue each: 70 distinct posts that nothing folds.
  for (let i = 0; i < 70; i++) {
    const made = await createUser(f.app.db, {
      origin: "seed",
      trusted: true,
      username: `lone-${i}`,
      email: `lone-${i}@forge.local`,
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const opened = openIssue(f.app, made.value, f.repos[0]!, { title: `A lone idea ${i}` });
    if (!opened.ok) throw new Error(String(opened.error));
  }
  const now = Date.now();
  const candidates = candidatesFor(f.app.db, f.owner, now, undefined, true);
  const aff = affinityFor(f.app.db, f.owner, now);
  // The feed folds bursts before it pages: the whole ranking is of the folded posts.
  const folded = foldBursts(candidates);
  const whole = rank(folded, aff, now);
  expect(whole.length).toBeGreaterThan(60);
  expect(rank(folded, aff, now, 51)).toEqual(whole.slice(0, 51));
  const page = readFeed(f.app.db, f.owner, { limit: 50, now });
  expect(page.items).toEqual(whole.slice(0, 50));
  expect(page.next_cursor).not.toBeNull();
});
