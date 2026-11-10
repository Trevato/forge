/**
 * A relayed wait the forge held says what held it (#11000): the stall's
 * route pattern or `job:<name>`, the longest first, on the app's speed card
 * and terminal line; a signed-in forge admin also gets `forge-stall` on the
 * relayed answer, and nobody else does.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { appVisitors, newApp } from "../src/actions/apps.ts";
import { signGrant } from "../src/apps/proxy.ts";
import {
  clearRelayWaits,
  heldBy,
  HELD_NAMES,
  isStallPattern,
  noteRelayWait,
  relayWait,
  relayWaitWords,
  stallTiming,
} from "../src/apps/relay_wait.ts";
import { visitorsLine, type AppVitals } from "../src/apps/vitals.ts";
import { appVisitorsView } from "../src/web/pages/settings.ts";
import { getAppByRepo } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createJobWatch, jobWatch } from "../src/perf/jobs.ts";
import { loopWatch } from "../src/perf/live.ts";
import { createLoopWatch, type Stall } from "../src/perf/loop.ts";
import { loopWorst } from "../src/perf/loop_worst.ts";
import { deploySettled } from "./helpers/apps-forge.ts";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const none: AppVitals = { today: 0, week: 0, ttfbP75: undefined, loadP75: undefined, lcpP75: undefined, inpP75: undefined, clsP75: undefined, loadDays: [] };
const stall = (lateMs: number, routes: string[], jobs: string[] = []): Stall => ({ at: 0, lateMs, routes, jobs });

beforeEach(() => clearRelayWaits());

describe("what held a wait", () => {
  test("a synthetic stall attributed to a job names it, on the card and the terminal line", () => {
    // A clock the test steps: the job's synchronous slice runs 0..600, the wake sees it at 600.
    let t = 0;
    const jobs = createJobWatch(() => t);
    const watch = createLoopWatch(250, jobs.across);
    jobs.during("sweep-runs", () => {
      t = 600;
    });
    const s = watch.stalled(600, 600)!;
    expect(s.jobs).toEqual(["sweep-runs"]);
    // The window the relay reads: the lag's 10 s before it.
    const held = heldBy(watch.within(600 - 10_000, 600));
    expect(held).toEqual([{ name: "job:sweep-runs", ms: 600 }]);
    // 820 ms to headers, 600 of it the forge's: the wait was the forge's, held by the job.
    noteRelayWait("a1", 820, 600, NOW, held);
    const wait = relayWait("a1", NOW)!;
    expect(wait.forge).toBe(true);
    const words = "the forge was busy: 600 ms of the 820 ms wait, held by job:sweep-runs (600 ms)";
    expect(relayWaitWords(wait)).toBe(words);
    expect(visitorsLine({ ...none, wait })).toEndWith(` · slowest wait, 10 min: ${words}`);
    expect(String(appVisitorsView({ ...none, wait }))).toContain(`<dd>${words}</dd>`);
  });

  test("nothing is named when the wait was the app's own", () => {
    // 1.5 s to headers, 40 ms lag: forgeWaited is false, so a stall handed in is dropped.
    noteRelayWait("a1", 1500, 40, NOW, [{ name: "/explore", ms: 300 }]);
    const wait = relayWait("a1", NOW)!;
    expect(wait.forge).toBe(false);
    expect(wait.held).toEqual([]);
    expect(relayWaitWords(wait)).toBe("1.5 s, the app's own");
    expect(visitorsLine({ ...none, wait })).not.toContain("held by");
  });

  test("the longest stall first, each name once, at most HELD_NAMES, the unnamed dropped", () => {
    const held = heldBy([
      stall(300, ["/explore"]),
      stall(900, ["/:owner/:name", "/explore"]),
      stall(400, [], []),
      stall(500, [], ["backup"]),
      stall(350, ["/robots.txt"]),
    ]);
    expect(held).toEqual([
      { name: "/:owner/:name", ms: 900 },
      { name: "/explore", ms: 900 },
      { name: "job:backup", ms: 500 },
    ]);
    expect(held.length).toBe(HELD_NAMES);
    expect(heldBy([stall(400, [], [])])).toEqual([]);
  });

  test("desc is always a pattern: no ids, no query, nothing to escape", () => {
    for (const ok of ["/", "/explore", "/:owner/:name/*", "/explore#read", "job:sweep-runs", "(unmatched)"])
      expect(isStallPattern(ok)).toBe(true);
    for (const bad of ["/explore?q=secret", 'job:"x"', "/a b", "/a;dur=1", "/a,b", "none", "", "alice/repo", `/${"a".repeat(200)}`, "/a\\b"])
      expect(isStallPattern(bad)).toBe(false);
    // A name that is not a pattern is never held, so never told.
    expect(heldBy([stall(900, ["/issues?id=01HXYZ", "/explore"])])).toEqual([{ name: "/explore", ms: 900 }]);
    expect(stallTiming([{ name: "/explore", ms: 1226.84 }, { name: "job:sweep", ms: 300 }])).toBe(
      'forge-stall;desc="/explore";dur=1226.8, forge-stall;desc="job:sweep";dur=300.0',
    );
    expect(stallTiming([{ name: "/x?y", ms: 1 }])).toBe("");
  });

  test("within reads the window's stalls, newest first", () => {
    const watch = createLoopWatch(250);
    watch.stalled(300, 1_000);
    watch.stalled(400, 5_000);
    watch.stalled(500, 12_000);
    expect(watch.within(2_000, 12_000).map((s) => s.at)).toEqual([12_000, 5_000]);
    expect(watch.within(13_000, 20_000)).toEqual([]);
  });
});

describe("forge-stall on the relayed answer", () => {
  const DOMAIN = "apps.test";
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let runtime: AppsRuntime;
  let alice: User;
  let bob: User;
  let repo: Repo;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stallname-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    runtime = new AppsRuntime(app, { domain: DOMAIN, scheme: "http", publicPort: servers.port, forgeUrl: servers.url });
    await runtime.start();
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    const made = await newApp(app, alice, { name: "hello", description: "d", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value.repo;
    expect((await deploySettled(app, repo.id, (r) => r.env === "production")).state).toBe("ok");
  }, 120_000);

  afterAll(async () => {
    await runtime.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A request to the app as `who` (a grant cookie), or as a visitor with none. */
  const asViewer = (who: User | undefined) => {
    const record = getAppByRepo(app.db, repo.id)!;
    const headers: Record<string, string> = { host: `hello.${DOMAIN}`, accept: "text/plain" };
    if (who !== undefined) {
      const grant = signGrant(app.config.dataDir, { app: record, env: "production" }, 60_000, Date.now(), {
        id: who.id,
        name: who.username,
        role: who.isAdmin ? "admin" : "user",
      });
      headers.cookie = `forge_grant_${record.id.slice(-8)}=${grant}`;
    }
    return fetch(`${servers.url}/`, { headers, redirect: "manual" });
  };

  /**
   * A synthetic stall of `ms` as job `name`, noted where a real one lands:
   * the lag window (`forge-lag`) and the loop watch the relay reads. Nothing
   * blocks the loop, so the test takes no time and the stall is exactly `ms`.
   */
  const stallAsJob = (name: string, ms: number) => {
    jobWatch.during(name, () => {});
    const now = performance.now();
    loopWorst.note(ms, now);
    const s = loopWatch.stalled(ms, now)!;
    // A route that ran across it outranks the job (setup's requests often do);
    // the job's own naming is pinned above, with a stepped clock.
    return heldBy([s])[0]!.name;
  };

  test("a forge admin sees the stall's pattern; a visitor and a signed-in non-admin do not", async () => {
    // 1 s: longer than any stall another suite in this process leaves in the window.
    const name = stallAsJob("stall-name-test", 1_000);
    expect(isStallPattern(name)).toBe(true);
    {
      const admin = await asViewer(alice);
      expect(admin.status).toBe(200);
      const timing = admin.headers.get("server-timing")!;
      expect(timing).toContain(`forge-stall;desc="${name}";dur=1000.0`);
      // Every desc a pattern, never a path's id or query.
      for (const m of timing.matchAll(/forge-stall;desc="([^"]*)"/g)) expect(isStallPattern(m[1]!)).toBe(true);
      // An admin's copy is never kept by a shared cache.
      expect(admin.headers.get("cache-control")).toBe("private, no-store");
      // The speed card names it too.
      expect(visitorsLine(appVisitors(app, alice, repo)!)).toContain(`${name} (1.0 s)`);

      for (const who of [undefined, bob]) {
        const res = await asViewer(who);
        expect(res.status).toBe(200);
        const header = res.headers.get("server-timing") ?? "";
        // The wait was the forge's (forge-lag is there) but the stall is not told.
        expect(header).toContain("forge-lag;dur=");
        expect(header).not.toContain("forge-stall");
        expect(header).not.toContain("job:");
      }
    }
  });
});
