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
import type { Graph } from "../src/core/dependencies.ts";
import { seedFixture, type Fixture, type Shape } from "../bench/map-home.ts";
import { countStatements } from "../bench/run.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

// `seedFixture` raises the log floor and never lowers it: borrowed for
// this file, and given back to whichever file runs next (#7419).
quietLogs();

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

/**
 * Many lanes and a real graph, without the forge's 60,000 events: the
 * statement counts asserted below depend on the code, not on the fixture's
 * size, and seeding the full size under load is what timed this suite out.
 */
const MANY: Shape = {
  repos: 20,
  bigIssues: 300,
  bigOpen: 60,
  bigGraph: 120,
  bigEdges: 200,
  bigPulls: 5,
  lanes: [20, 12, 9, 6, 4, 2, 1, 1],
  privateLanes: 2,
  sealed: 2,
  runs: 3,
  comments: 2,
  events: 1_000,
};

/** What the page around the lanes reads, however many lanes there are. */
const CHROME = 26;

/**
 * A fixture lives only as long as its describe: three held to the end of the
 * file were ~19 MB of repositories on a check machine that ran out of disk
 * (pull #5178), where a seed fails `git_init_failed` with nothing wrong here.
 */
const dirs = new Set<string>();
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

async function boot(shape: Shape): Promise<{ f: Fixture; servers: Servers; release: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "forge-map-cache-"));
  dirs.add(dir);
  clearMapCache();
  let f: Fixture | undefined;
  let servers: Servers | undefined;
  const release = () => {
    servers?.stop();
    f?.app.close();
    rmSync(dir, { recursive: true, force: true });
    dirs.delete(dir);
  };
  try {
    f = await seedFixture(dir, shape);
    servers = await serve(f.app);
  } catch (error) {
    release();
    throw error;
  }
  return { f, servers, release };
}

const get = async (servers: Servers, path: string, cookie: string): Promise<string> =>
  (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

const lanesIn = (page: string): number => page.split('<details id="lane-').length - 1;

describe("/map on a many-lane fixture, warm", () => {
  let servers: Servers;
  let f: Fixture;
  let release: (() => void) | undefined;
  beforeAll(async () => {
    ({ f, servers, release } = await boot(MANY));
  }, 120_000);
  // A boot that failed has nothing to stop: its own error is the one reported.
  afterAll(() => release?.(), 60_000);

  for (const who of ["owner", "stranger"] as const) {
    test(`${who}: a warm hit does a fraction of a cold build's work, statements within a fixed cost + 2 per lane`, async () => {
      const cookie = who === "owner" ? f.ownerCookie : f.strangerCookie;
      // Both viewers share one cache, so drop it here: the first request is a
      // real cold build for this viewer, whichever test ran before.
      clearMapCache();
      const coldCounter = countStatements(f.app.db);
      let cold: number;
      let warm: string;
      try {
        warm = await get(servers, "/map", cookie);
        cold = coldCounter.count;
      } finally {
        coldCounter.stop();
      }
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
      // The steady state: a lane's minute or the UTC day turning over mid-loop
      // rebuilds one request, and that is the cache working, not failing.
      counts.sort((a, b) => a - b);
      const statements = counts[counts.length >> 1]!;
      console.log(`${who}: ${lanes} lanes, p95 ${p95.toFixed(1)} ms, ${statements} statements (cold ${cold})`);
      // Wall-clock is the check machine's load, so the verdict is read from
      // statement counts, which depend only on the code: a missing cache
      // puts the cold and warm counts level. The doc's 50 ms budget is read
      // off bench/map-home.ts. p95 below is a hang guard, nothing more.
      expect(statements * 3).toBeLessThan(cold);
      expect(p95).toBeLessThan(5_000);
      // The page's own chrome costs a fixed ~25 statements (session, settings,
      // the repository lists); a lane costs at most two. Cold, it was about 350 statements on this fixture.
      expect(statements).toBeLessThanOrEqual(CHROME + 2 * lanes);
    }, 60_000);
  }
});

describe("/map after a write", () => {
  let servers: Servers;
  let f: Fixture;
  let release: (() => void) | undefined;
  let owner: User;
  let stranger: User;
  const repoOf = (name: string): Repo => getRepo(f.app.db, "keeper", name)!;
  beforeAll(async () => {
    ({ f, servers, release } = await boot(SMALL));
    owner = getUserByName(f.app.db, "keeper")!;
    stranger = getUserByName(f.app.db, "passerby")!;
  }, 60_000);
  // A boot that failed has nothing to stop: its own error is the one reported.
  afterAll(() => release?.(), 60_000);

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

    // A lane is drawn when asked for (`?lane=`), so the drawings are asked for.
    const pubLane = `/map?lane=${pub.ownerName}/${pub.name}`;
    const privLane = `/map?lane=${privateRepo}`;
    const warmed = await get(servers, pubLane, f.ownerCookie);
    expect(warmed).toContain("Hidden hole in login");
    expect(await get(servers, privLane, f.ownerCookie)).toContain(privateTitle);

    for (const path of ["/map", pubLane, privLane, "/api/v1/map"]) {
      const seen = await get(servers, path, f.strangerCookie);
      expect(seen).not.toContain("Hidden hole in login");
      expect(seen).not.toContain(privateTitle);
      expect(seen).not.toContain(privateName);
    }
    // And the other way: the stranger warming first does not hide it from the owner.
    expect(await get(servers, pubLane, f.ownerCookie)).toContain("Hidden hole in login");
    // Unsealing is a write the doc names: the stranger sees it next.
    if (sealed.ok) setIssueSealed(f.app, owner, pub, sealed.value, false);
    expect(await get(servers, pubLane, f.strangerCookie)).toContain("Hidden hole in login");
    expect(stranger.id).not.toBe(owner.id);
  });
});

describe("the layout key", () => {
  test("is the graph's own ids and edges, never its titles", () => {
    // A literal graph: the verdict is the code's alone, with no database,
    // server or seeded fixture for the check machine's load to slow down.
    const issue = (n: number) => ({ id: `id-${n}`, number: n, title: `Step ${n}` });
    const graph = {
      issues: [issue(1), issue(2), issue(3)],
      edges: [
        { issueId: "id-2", blockedById: "id-1" },
        { issueId: "id-3", blockedById: "id-2" },
      ],
      held: [],
      unadopted: new Set<string>(),
      structural: new Set<string>(),
      deferred: new Map<string, string>(),
    } as unknown as Graph;
    const key = layoutKey(graph);
    const retitled = {
      ...graph,
      issues: graph.issues.map((i) => ({ ...i, title: `${i.title}!` })),
    };
    expect(layoutKey(retitled)).toBe(key);
    expect(layoutKey({ ...graph, edges: graph.edges.slice(1) })).not.toBe(key);
    expect(layout(graph).nodes.length).toBe(graph.issues.length);
  });
});

describe("/map's Server-Timing names its phases", () => {
  let servers: Servers;
  let f: Fixture;
  let release: (() => void) | undefined;
  beforeAll(async () => {
    ({ f, servers, release } = await boot(SMALL));
  }, 120_000);
  // A boot that failed has nothing to stop: its own error is the one reported.
  afterAll(() => release?.(), 60_000);

  for (const who of ["owner", "stranger"] as const) {
    test(`${who}: session, lanes, layout and render follow app, and sum to no more than it`, async () => {
      clearMapCache();
      const cookie = who === "owner" ? f.ownerCookie : f.strangerCookie;
      for (const pass of ["cold", "warm"]) {
        const res = await fetch(`${servers.url}/map`, { headers: { cookie } });
        const header = requestTiming(res);
        const dur = new Map(
          [...header.matchAll(/([a-z-]+);dur=(\d+\.\d)/g)].map((m) => [m[1]!, Number(m[2])]),
        );
        const names = [...dur.keys()];
        expect(names.slice(-4), `${pass}: ${header}`).toEqual(["session", "lanes", "layout", "render"]);
        expect(header.split(", ").every((p) => /^[a-z-]+;dur=\d+\.\d$/.test(p))).toBe(true);
        const phases = ["session", "lanes", "layout", "render"];
        const sum = phases.reduce((n, k) => n + dur.get(k)!, 0);
        // The phases are disjoint stretches inside `app`, so their true sum is
        // at most app's. `serverTiming` prints each with toFixed(1), off by at
        // most half a tenth: four phases rounded up and app rounded down is
        // the whole slack, 5 × 0.05 ms, with a hair for binary fractions.
        const slack = (phases.length + 1) * 0.05 + 1e-9;
        expect(sum, header).toBeLessThanOrEqual(dur.get("app")! + slack);
        // No repository name rides in the header.
        expect(header).not.toMatch(/\//);
      }
    });
  }
});
