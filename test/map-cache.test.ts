/**
 * /map is built from the cache docs/CACHING.md designs (#2716): fast and
 * cheap when warm, never stale after a write the doc names, and never a
 * way for one viewer to read what another may see.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue, setIssueSealed, setIssueState } from "../src/actions/issues.ts";
import { getIssue } from "../src/core/issues.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearMapCache, layoutKey } from "../src/web/map_cache.ts";
import { layout } from "../src/web/pages/map.ts";
import { repoGraph } from "../src/core/dependencies.ts";
import { FORGE_SIZE, seedFixture, type Fixture, type Shape } from "../bench/map-home.ts";
import { countStatements } from "../bench/run.ts";

const SMALL: Shape = {
  repos: 6,
  bigIssues: 40,
  bigOpen: 12,
  bigGraph: 20,
  bigEdges: 24,
  bigPulls: 2,
  lanes: [5, 3, 2],
  privateLanes: 1,
  sealed: 1,
  runs: 2,
  comments: 1,
  events: 50,
};

/** What the page around the lanes reads, however many lanes there are. */
const CHROME = 26;

const dirs: string[] = [];
const fixtures: Fixture[] = [];
afterAll(() => {
  for (const f of fixtures) f.app.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

async function boot(shape: Shape): Promise<{ f: Fixture; servers: Servers }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-map-cache-"));
  dirs.push(dir);
  clearMapCache();
  const f = await seedFixture(dir, shape);
  fixtures.push(f);
  return { f, servers: await serve(f.app) };
}

const get = async (servers: Servers, path: string, cookie: string): Promise<string> =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

const lanesIn = (page: string): number => page.split('class="map-lane"').length - 1;

describe("/map on the forge-sized fixture, warm", () => {
  let servers: Servers;
  let f: Fixture;
  beforeAll(async () => {
    ({ f, servers } = await boot(FORGE_SIZE));
  }, 120_000);
  afterAll(() => servers.stop(), 60_000);

  for (const who of ["owner", "stranger"] as const) {
    test(`${who}: warm hits far cheaper than a cold build, statements within a fixed cost + 2 per lane`, async () => {
      const cookie = who === "owner" ? f.ownerCookie : f.strangerCookie;
      // Both viewers share one cache, so drop it here: the first request is a
      // real cold build for this viewer, whichever test ran before.
      clearMapCache();
      const coldStarted = performance.now();
      const warm = await get(servers, "/map", cookie);
      const cold = performance.now() - coldStarted;
      const lanes = lanesIn(warm);
      expect(lanes).toBeGreaterThan(5);
      const counter = countStatements(f.app.db);
      const times: number[] = [];
      const counts: number[] = [];
      try {
        for (let n = 0; n < 20; n++) {
          counter.reset();
          const started = performance.now();
          await get(servers, "/map", cookie);
          times.push(performance.now() - started);
          counts.push(counter.count);
        }
      } finally {
        counter.stop();
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      const median = times[times.length >> 1]!;
      // The steady state: a lane's minute or the UTC day turning over mid-loop
      // rebuilds one request, and that is the cache working, not failing.
      counts.sort((a, b) => a - b);
      const statements = counts[counts.length >> 1]!;
      console.log(`${who}: ${lanes} lanes, p95 ${p95.toFixed(1)} ms, ${statements} statements`);
      // Wall-clock is the check machine's, so it is only ever a ratio between
      // two timings taken here, a real cold build and the warm median: a
      // missing cache puts them level. The doc's 50 ms budget is read off
      // bench/map-home.ts. p95 below is a hang guard, nothing more.
      expect(median * 3).toBeLessThan(cold);
      expect(p95).toBeLessThan(5_000);
      // The page's own chrome costs a fixed ~25 statements (session, settings,
      // the repository lists); a lane costs at most two. Cold, it was ~2,700.
      expect(statements).toBeLessThanOrEqual(CHROME + 2 * lanes);
    }, 60_000);
  }
});

describe("/map after a write", () => {
  let servers: Servers;
  let f: Fixture;
  let owner: User;
  let stranger: User;
  const repoOf = (name: string): Repo => getRepo(f.app.db, "keeper", name)!;
  beforeAll(async () => {
    ({ f, servers } = await boot(SMALL));
    owner = getUserByName(f.app.db, "keeper")!;
    stranger = getUserByName(f.app.db, "passerby")!;
  }, 60_000);
  afterAll(() => servers.stop(), 60_000);

  test("an issue opened, then closed, shows on the next /map", async () => {
    const repo = repoOf("plan-0");
    await get(servers, "/map", f.ownerCookie);
    const opened = openIssue(f.app, owner, repo, { title: "Zebra crossing" });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(await get(servers, "/map", f.ownerCookie)).toContain("Zebra crossing");
    const issue = getIssue(f.app.db, repo.id, opened.value.number)!;
    const closed = setIssueState(f.app, owner, repo, issue, "closed");
    expect(closed.ok).toBe(true);
    expect(await get(servers, "/map", f.ownerCookie)).not.toContain("Zebra crossing");
  });

  test("an edited title shows although the layout is kept", async () => {
    const repo = repoOf("plan-1");
    const before = await get(servers, "/map", f.ownerCookie);
    expect(before).toContain("Plan 1 step 0");
    f.app.db
      .query("UPDATE issue SET title = 'Renamed step' WHERE repo_id = ?1 AND title = 'Plan 1 step 0'")
      .run(repo.id);
    // A title is not part of the layout's key, so the layout is the same entry.
    f.app.bus.append({ kind: "issue.edited", repoId: repo.id, payload: {} });
    const after = await get(servers, "/map", f.ownerCookie);
    expect(after).toContain("Renamed step");
    expect(after).not.toContain("Plan 1 step 0");
  });

  test("a sealed issue and a private lane never reach a stranger once the owner has warmed them", async () => {
    const pub = repoOf("plan-0");
    const sealed = openIssue(f.app, owner, pub, { title: "Hidden hole in login", sealed: true });
    expect(sealed.ok).toBe(true);
    const [privateRepo] = f.privateRepos;
    const privateName = privateRepo!.split("/")[1]!;
    const privateTitle = "Plan 2 step 0";

    const warmed = await get(servers, "/map", f.ownerCookie);
    expect(warmed).toContain("Hidden hole in login");
    expect(warmed).toContain(privateTitle);

    for (const path of ["/map", "/api/v1/map"]) {
      const seen = await get(servers, path, f.strangerCookie);
      expect(seen).not.toContain("Hidden hole in login");
      expect(seen).not.toContain(privateTitle);
      expect(seen).not.toContain(privateName);
    }
    // And the other way: the stranger warming first does not hide it from the owner.
    expect(await get(servers, "/map", f.ownerCookie)).toContain("Hidden hole in login");
    // Unsealing is a write the doc names: the stranger sees it next.
    if (sealed.ok) setIssueSealed(f.app, owner, pub, sealed.value, false);
    expect(await get(servers, "/map", f.strangerCookie)).toContain("Hidden hole in login");
    expect(stranger.id).not.toBe(owner.id);
  });
});

describe("the layout key", () => {
  test("is the graph's own ids and edges, never its titles", async () => {
    const { f, servers } = await boot(SMALL);
    try {
      const repo = getRepo(f.app.db, "keeper", "forge")!;
      const graph = repoGraph(f.app.db, repo.id, { sealed: true });
      const key = layoutKey(graph);
      const retitled = {
        ...graph,
        issues: graph.issues.map((i) => ({ ...i, title: `${i.title}!` })),
      };
      expect(layoutKey(retitled)).toBe(key);
      expect(layoutKey({ ...graph, edges: graph.edges.slice(1) })).not.toBe(key);
      expect(layout(graph).nodes.length).toBe(graph.issues.length);
    } finally {
      servers.stop();
    }
  }, 60_000);
});
