/**
 * Snappy everywhere (#2675): `/map` and `/` answer inside their budgets on
 * the bench fixture (`bench/snappy.ts`), and the caches that make them do
 * so (docs/CACHING.md) are exact — a write is seen on the next read, one
 * viewer's view is never served to another, and nothing is cached inside a
 * transaction or across another connection's write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { openIssue, setIssueState as closeIssue } from "../src/actions/issues.ts";
import { linkIssue } from "../src/actions/dependencies.ts";
import { writeStamp } from "../src/core/write_clock.ts";
import { feedCandidateCache, readFeed } from "../src/feed/feed.ts";
import { mapCacheStats } from "../src/web/map_cache.ts";
import { snappyFixture, timeRoute, type SnappyFixture } from "../bench/snappy.ts";

/**
 * The budgets, per request on the fixture: twelve apps of 24 planned
 * issues each. Latency is stated far above what the pages take (about
 * 10–20 ms here, docs/CACHING.md) so a loaded check machine does not
 * redden it; the statement counts are the tight, deterministic half —
 * before #2675 these pages issued 945 and 1892, cache or none.
 */
const P95_MS = 250;
const SQL = { mapOwner: 80, mapMember: 60, homeOwner: 220, homeMember: 180 };
/** After a write every cache misses: what the grouped reads alone must hold. */
const COLD_SQL = { mapOwner: 450, homeOwner: 260 };

let f: SnappyFixture;
const page = async (path: string, cookie?: string): Promise<string> =>
  (await fetch(`${f.base}${path}`, { headers: cookie ? { cookie } : {} })).text();

beforeAll(async () => {
  f = await snappyFixture();
}, 120_000);
afterAll(async () => {
  await f.close();
});

describe("budgets", () => {
  test("/map and / answer under their p95 and statement budgets", async () => {
    const owner = { cookie: f.ownerCookie };
    const peer = { cookie: f.peerCookie };
    let k = 0;
    const touch = () =>
      f.app.db
        .query("UPDATE repo SET description = ?1 WHERE id = ?2")
        .run(`touched ${k++}`, f.repos[0]!.id);
    const rows = [
      [await timeRoute(f, "map owner", "/map", owner, 20), SQL.mapOwner],
      [await timeRoute(f, "map member", "/map", peer, 20), SQL.mapMember],
      [await timeRoute(f, "home owner", "/", owner, 20), SQL.homeOwner],
      [await timeRoute(f, "home member", "/", peer, 20), SQL.homeMember],
      [await timeRoute(f, "home stranger", "/", {}, 20), 19],
      [await timeRoute(f, "map owner cold", "/map", owner, 20, touch), COLD_SQL.mapOwner],
      [await timeRoute(f, "home owner cold", "/", owner, 20, touch), COLD_SQL.homeOwner],
    ] as const;
    for (const [timing, sql] of rows) {
      expect({ name: timing.name, status: timing.status }).toEqual({ name: timing.name, status: 200 });
      expect({ name: timing.name, ok: timing.p95 < P95_MS }).toEqual({ name: timing.name, ok: true });
      expect({ name: timing.name, ok: timing.sql <= sql, sql: timing.sql }).toMatchObject({ name: timing.name, ok: true });
    }
  }, 60_000);

  test("a warm /map computes no lane: every plan is a hit", async () => {
    await page("/map", f.ownerCookie);
    const misses = mapCacheStats().lanes.misses;
    await page("/map", f.ownerCookie);
    expect(mapCacheStats().lanes.misses).toBe(misses);
  });
});

describe("the caches are exact", () => {
  // Through the actions, which append the event that moves a lane's head
  // (docs/CACHING.md, "Lane writes").
  test("a write is on the very next map: a new issue, a new edge, a closed one", async () => {
    const repo = f.repos[1]!;
    // A lane's drawing comes when asked for (#8693).
    const lanePage = (cookie: string) => page(`/map?lane=${repo.ownerName}/${repo.name}`, cookie);
    await page("/map", f.ownerCookie);
    const opened = openIssue(f.app, f.owner, repo, { title: "Zeppelin moorings" });
    if (!opened.ok) throw new Error(String(opened.error));
    expect(await lanePage(f.ownerCookie)).toContain("Zeppelin moorings");

    const second = openIssue(f.app, f.owner, repo, { title: "Quokka census" });
    if (!second.ok) throw new Error(String(second.error));
    await page("/map", f.ownerCookie);
    expect(linkIssue(f.app, f.owner, repo, second.value, opened.value).ok).toBe(true);
    const json = async () =>
      (await (await fetch(`${f.base}/api/v1/map`, { headers: { cookie: f.ownerCookie } })).json()) as {
        repos: { repo: { name: string }; edges: { issue: number; blockedBy: number }[] }[];
      };
    const lane = (await json()).repos.find((r) => r.repo.name === repo.name)!;
    expect(lane.edges).toContainEqual({ issue: second.value.number, blockedBy: opened.value.number });

    // An issue on no edge leaves the map when it closes.
    const lone = openIssue(f.app, f.owner, repo, { title: "Narwhal tally" });
    if (!lone.ok) throw new Error(String(lone.error));
    expect(await lanePage(f.ownerCookie)).toContain("Narwhal tally");
    expect(closeIssue(f.app, f.owner, repo, lone.value, "closed").ok).toBe(true);
    expect(await lanePage(f.ownerCookie)).not.toContain("Narwhal tally");
  });

  test("a sealed issue the owner's map drew is not drawn for a member who may not see it", async () => {
    // app-0 is public: the member reads it, but not what is sealed in it.
    const repo = f.repos[0]!;
    const lane = `/map?lane=${repo.ownerName}/${repo.name}`;
    const sealed = openIssue(f.app, f.owner, repo, { title: "Sealed vault combination", sealed: true });
    if (!sealed.ok) throw new Error(String(sealed.error));
    // Warm in both orders: the owner first, then the member, then the owner.
    expect(await page(lane, f.ownerCookie)).toContain("Sealed vault combination");
    const member = await page(lane, f.peerCookie);
    expect(member).toContain(`lane-olive-${repo.name}`);
    expect(member).not.toContain("Sealed vault combination");
    expect(await page(lane, f.ownerCookie)).toContain("Sealed vault combination");
    // And the member's own private repository is never on the owner's
    // stranger-scoped lanes either way: it is listed by visibility per request.
    expect(await page("/map", f.peerCookie)).toContain("lane-pablo-notes");
  });

  test("one viewer's feed is never another's, and a write is in the next one", async () => {
    const whats = (who: typeof f.owner) =>
      readFeed(f.app.db, who, { limit: 50 }).items.map((i) => [i.what, ...(i.lines ?? []).map((l) => l.text)].join("\n")).join("\n");
    // Both warm, before the write.
    whats(f.owner);
    whats(f.peer);
    const repo = f.repos[2]!; // private to the owner
    const told = openIssue(f.app, f.owner, repo, { title: "Private memo for olive only" });
    if (!told.ok) throw new Error(String(told.error));
    expect(whats(f.owner)).toContain("Private memo for olive only");
    expect(whats(f.peer)).not.toContain("Private memo for olive only");
    // Nothing written since: the owner's next feed is a hit.
    const cache = feedCandidateCache(f.app.db);
    const misses = cache.misses;
    expect(whats(f.owner)).toContain("Private memo for olive only");
    expect(cache.misses).toBe(misses);
  });

  test("no stamp inside a transaction, and another connection's write moves it", () => {
    const db = f.app.db;
    const before = writeStamp(db);
    expect(before).toBeDefined();
    db.transaction(() => {
      expect(writeStamp(db)).toBeUndefined();
    })();
    expect(writeStamp(db)).toBe(before);
    const other = new Database(join(f.dataDir, "forge.db"));
    other.run("PRAGMA busy_timeout = 5000");
    other.run("UPDATE repo SET description = 'touched elsewhere' WHERE id = ?", [f.repos[3]!.id]);
    other.close();
    expect(writeStamp(db)).not.toBe(before);
  });
});
