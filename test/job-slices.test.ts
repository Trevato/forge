// @tree-scan: lists the repository through a walk it hands a rooted path.
/**
 * How long each background job holds the loop (#11118): one fixture with a busy forge's
 * volume (thousands of issues and pulls, tens of thousands of runs, comments and events)
 * is built once, and each job the forge runs under `during` ticks against it. A job's slice
 * is the longest stretch it kept the loop from turning: its synchronous call, or for an async
 * job the worst gap a `setImmediate` chain saw while it ran. Seams that leave the process
 * (git, the network, a child process, a cell) are fakes or fail fast, so what is timed is the
 * forge's own synchronous work. Every name passed to `during` in src/ is either timed here or
 * in UNTIMED with the reason, so a new job cannot go unmeasured.
 *
 * The table is printed worst first for the pull. No absolute number is asserted against a
 * raw clock at the 50 ms the issue names (`test/flake.test.ts`, #7824): each job is held only
 * under CEILING_MS, five times that, which a regression crosses and a slow runner does not.
 * The memory sampler's fix is asserted relative to one walk of the same heap in the same run.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { heapStats } from "bun:jsc";
import type { App } from "../src/app.ts";
import { bigForge } from "./helpers/big-forge.ts";
import { quietLogs } from "./helpers/globals.ts";
import { startSampler } from "../src/boards/sampler.ts";
import { startMemorySampler } from "../src/boards/memory.ts";
import { tickKeeper } from "../src/flow/keeper.ts";
import { tickClog } from "../src/flow/clog_tick.ts";
import { pump, recheckForDisk, requeueInterrupted, sweepAssigned } from "../src/crew/dispatch.ts";
import type { CrewOptions } from "../src/crew/runner.ts";
import { crewRoot } from "../src/crew/workdir.ts";
import { claimedClones, sweepOrphanClones } from "../src/crew/orphans.ts";
import { pruneRunFiles } from "../src/runs/prune.ts";
import { radarNight } from "../src/nightly/radar.ts";
import { runAheadReads } from "../src/origins/ahead.ts";
import { runGuardSweep } from "../src/origins/credential.ts";
import { sweepMirrorPulls } from "../src/origins/mirror-pulls.ts";
import { sweepReach } from "../src/spawn/reach.ts";
import { checkUpstream as checkParent } from "../src/spawn/upstream.ts";
import { census, censusWords, processRows } from "../src/kernel/census.ts";
import { runDelivery } from "../src/core/webhooks.ts";
import { pruneSessions } from "../src/core/sessions.ts";
import { pruneTokens } from "../src/core/tokens.ts";
import { runSync } from "../src/origins/sync.ts";
import { checkDue } from "../src/actions/upstream_follow.ts";
import { sweepStaleAsks } from "../src/crew/stale_asks.ts";
import { sweepStanding } from "../src/crew/standing.ts";
import { recordAskLedger } from "../src/web/studio/asks.ts";
import { sweepStarts } from "../src/actions/start_sweep.ts";
import { expireCrewHolds } from "../src/actions/holds.ts";
import { plannedRepoIds, tickWeeks } from "../src/flow/retro.ts";
import { getRepoById } from "../src/core/repos.ts";
import { failAbandonedRuns, heartbeatRuns } from "../src/core/runs.ts";
import { sleepBelowFloor, sleepIdleChildren } from "../src/spawn/host.ts";
import { createReadLedger, createReadWriter } from "../src/perf/reads.ts";
import { flushViews, noteView } from "../src/perf/views_store.ts";
import { requeueAbandonedChecks } from "../src/checks/service.ts";
import { releaseOrphans } from "../src/core/run_secret.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { flushFlagUses } from "../src/core/flags.ts";
import { sendBeat } from "../src/spawn/heartbeat.ts";
import { runModelReview } from "../src/actions/model_review.ts";
import { readLandings } from "../src/release/landings.ts";
import { sweepStanding as sweepCallers } from "../src/http/caller.ts";
import { nightlyDue } from "../src/checks/scan_store.ts";
import { startNotifier } from "../src/crew/notify.ts";
import { fireDue } from "../src/apps/feature_schedule.ts";
import { pullDue } from "../src/apps/pull_schedule.ts";
import { startMaintain } from "../src/maintain/runner.ts";

/** Thousands of issues and pulls, as the issue asks; runs, comments and events thinned so the file runs in seconds (#1242). */
const BUSY = { issues: 2000, pulls: 2000, requested: 100, runs: 5000, comments: 5000, events: 10000, reviewComments: 500 };

// A job's warnings (a sandbox without git warns once per pull) are not its slice: the terminal's write is.
quietLogs();

let app: App;
let dir = "";
beforeAll(() => {
  ({ app, dir } = bigForge(BUSY));
  // A crew with work: a queue past the pump's 50-run window, and runs a dead forge left running.
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const run = app.db.prepare(
    "INSERT INTO run (id, repo_id, issue_id, kind, state, reason, summary, created_at, started_at, actor_id) VALUES (?1, 'r', ?2, 'agent', ?3, 'assigned', '', ?4, ?5, 'builder')",
  );
  for (let n = 1; n <= 80; n++) run.run(`q${n}`, `i${n}`, "queued", at, null);
  for (let n = 81; n <= 90; n++) run.run(`s${n}`, `i${n}`, "running", at, at);
  reads = createReadWriter(app.db, readLedger, app.log, Date.now, 1e9);
}, 60_000);
afterAll(() => {
  reads.stop();
  app.db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The longest the loop stood still while `fn` ran, in ms: its synchronous call, or any continuation after. */
async function slice(fn: () => unknown): Promise<number> {
  let last = performance.now();
  let worst = 0;
  let turning = true;
  const turn = (): void => {
    const at = performance.now();
    worst = Math.max(worst, at - last);
    last = at;
    if (turning) setImmediate(turn);
  };
  setImmediate(turn);
  const start = performance.now();
  const result = fn();
  const sync = performance.now() - start;
  await Promise.resolve(result).catch(() => undefined);
  turning = false;
  await new Promise((resolve) => setImmediate(resolve));
  return Math.max(sync, worst);
}

/** The runs the fixture left running (s81–s90): the leases `lease-renew` renews. */
const RUNNING = Array.from({ length: 10 }, (_, i) => `s${81 + i}`);
const NO_ORIGIN = { refHost: "", source: "", medium: "", campaign: "", out: "" };
const readLedger = createReadLedger();
let reads: { flush(): void; stop(): void };

/** No free slot: the crew's pump gates every queued run and starts none. */
const NO_SLOT: CrewOptions = {
  forgeUrl: "https://forge.test/", localUrl: "http://127.0.0.1:0/", binary: "/nonexistent/claude",
  concurrency: 0, budgetUsd: 0, runTimeoutMs: 1,
};

/** Each job's tick, by the name it runs under in `during`, as the forge's timer calls it. */
function jobs(): Record<string, () => unknown> {
  const notifier = startNotifier(app, {
    forgeUrl: "https://forge.test/", send: async () => true, clockMs: 1e9,
    drainingSince: () => null, causes: () => [], alarms: () => [],
  });
  notifier.stop();
  const sampler = startSampler(app, { everyMs: 1e9 });
  const memory = startMemorySampler(app, 1e9);
  sampler.stop();
  memory.stop();
  const maintainer = startMaintain(app, { everyMs: 1e9 });
  maintainer.stop();
  return {
    sampler: () => sampler.tick(),
    "memory-sampler": () => memory.tick(),
    keeper: () => tickKeeper(app, new Date(), () => {}),
    clog: () => tickClog(app.db, app.bus),
    // The crew's boot tick and its timer's, together. With no free slot `pump` orders, gates
    // and holds every queued run but starts none: a start spawns Claude Code, not the loop's work.
    crew: () => {
      requeueInterrupted(app);
      recheckForDisk(app);
      sweepAssigned(app);
      pump(app, NO_SLOT, new Map());
    },
    // The orphan sweep reads the crew root (empty here); the claims it checks against are the fixture's.
    "clone-sweep": async () => {
      await sweepOrphanClones(crewRoot(app.config.dataDir), claimedClones(app.db));
      pruneRunFiles(app.config.dataDir);
    },
    // The radar's night: every repository's pins (git fails fast: no repositories on disk), npm faked.
    nightly: () => radarNight(app, async () => "not looked up"),
    // The census of /proc main.ts logs each minute (`processTick`), without the crew's reaping.
    processes: () => censusWords(census(processRows())),
    // The fixture has no origins, mirrors, children or parent link: each is its empty pass, one read.
    ahead: () => runAheadReads(app),
    "guard-sweep": () => runGuardSweep(app),
    "mirror-pulls": () => sweepMirrorPulls(app),
    reach: () => sweepReach(app),
    upstream: () => checkParent(app),
    // Its first pass on start tells and pages everyone (`tell(id, true)`, then `page`), a superset of the clock's tick.
    notify: async () => {
      const told = startNotifier(app, {
        forgeUrl: "https://forge.test/", send: async () => true, clockMs: 1e9,
        drainingSince: () => null, causes: () => [], alarms: () => [],
      });
      await told.settled();
      await told.close();
    },
    // The disk floor and the idle sweep over the hosted children; the fixture hosts none.
    "spawn-floor": () => sleepBelowFloor(app),
    "spawn-idle": () => sleepIdleChildren(app),
    // One renewal of every lease this process holds: the runs a dead forge left running.
    "lease-renew": () => heartbeatRuns(app.db, RUNNING),
    // A minute's reads and page views, buffered then written in one flush: the noting is in the slice too.
    reads: () => {
      for (let n = 0; n < 1000; n++) readLedger.note(Date.now(), { repo: "r", ref: "main", path: `f${n % 400}` }, n % 2 === 0);
      reads.flush();
    },
    views: () => {
      for (let n = 0; n < 1000; n++)
        noteView(app.db, { scope: "r", path: `/p${n % 200}`, origin: NO_ORIGIN, client: `c${n % 300}`, agent: "Mozilla/5.0" });
      flushViews(app.db);
    },
    delivery: () => {
      runDelivery(app.db, app.log, app.bus);
      pruneSessions(app.db);
      pruneTokens(app.db);
    },
    sync: () => runSync(app),
    follow: () => checkDue(app),
    asks: async () => {
      await sweepStaleAsks(app);
      await sweepStanding(app);
      recordAskLedger(app.db);
    },
    starts: () => sweepStarts(app),
    holds: () => expireCrewHolds(app),
    week: () => {
      const repos = plannedRepoIds(app.db).flatMap((id) => getRepoById(app.db, id) ?? []);
      tickWeeks(app.db, repos, new Date());
    },
    lease: () => {
      failAbandonedRuns(app.db, STALE_AFTER_MS, ["deploy"]);
      requeueAbandonedChecks(app, STALE_AFTER_MS);
      releaseOrphans(app.db);
    },
    "flag-uses": () => flushFlagUses(app.db),
    heartbeat: () => sendBeat(app, async () => new Response("")),
    "model-review": () => runModelReview(app),
    landings: () => readLandings(app),
    "notify-page": async () => {
      await notifier.settled(); // the notifier's first pass on start is its own, not the pager's
      await notifier.tick();
    },
    "standing-sweep": () => sweepCallers(app.db, () => {}),
    "nightly-scan": () => nightlyDue(app.db, new Date(Date.now() - 24 * 3_600_000).toISOString(), 25),
    "feature-schedule": () => fireDue(app),
    "pull-schedule": () => pullDue(app),
    maintain: () => maintainer.tick(new Date(Date.now() + 1e9)),
  };
}

/**
 * The jobs not timed here, each with why. The release keeper's are off unless a cluster turns them on.
 */
const UNTIMED: Record<string, string> = {
  lane: "a closure in startChecks; starting the checks service starts cell checks — follow-up",
  "lane-catch-up": "a closure in startChecks, once on boot; same as lane",
  "verify-sweep": "a closure in startChecks, off unless verifyEveryMs is set; same as lane",
  looks: "a closure in startLooks; needs the apps runtime and chromium, and the fixture has no apps",
  "perf-watcher": "a closure in startPerfWatcher over its own in-memory record; the fixture has no FORGE_REPO to file in",
  probes: "probes each app over HTTP after a deploy and nightly; the fixture has no apps",
  prompts: "a closure in startPromptRoutine; the fixture has no prompt routines",
  timers: "fires due app timers over HTTP to the apps; the fixture has no apps",
  snapshot: "copies the database file to disk (VACUUM INTO): I/O off the loop, nightly",
  "snapshot-mirror": "uploads a snapshot to the mirror: network, nightly",
  drill: "restores a snapshot into a scratch forge: nightly, I/O",
  "release-behind": "reads the forge's own release tags with git; needs FORGE_REPO and its repository",
  "release-keeper": "cluster only (FORGE_RELEASE_KEEPER=on): talks to the cluster's API",
  "roll-probe": "cluster only (FORGE_RELEASE_KEEPER=on): one HTTP probe",
  "apps-sweep": "AppsRuntime's sweep over running app processes; the fixture has no apps",
  "cell-watch": "watches running app cells' cgroups; needs cells, skipped in this sandbox mode",
  "cell-probe-deadline": "a cell's start probe running out of time: needs cells, skipped in this sandbox mode",
  "cell-kill-root": "kills a cell's root process after its grace: needs cells, skipped in this sandbox mode",
  "cell-duty-resume": "sends SIGCONT to a cell tree the duty pause stopped: needs cells, skipped in this sandbox mode",
  "apps-restart": "restarts an app process after it exits; the fixture has no apps",
  "app-tty-idle": "closes an app terminal left idle; the fixture has no app terminals",
  "route-timing-flush": "a debounced write of route timings: runs after requests, the jobs here make none",
  "usage-count-flush": "a debounced write of usage counts: runs after requests, the jobs here make none",
  "access-flush": "a debounced write of the access log: runs after requests, the jobs here make none",
  "egress-refused-flush": "a debounced write of an app's refused hosts; needs the egress proxy and apps",
  "nightly-output-flush": "a debounced write of a nightly job's output: inside a nightly run",
  "home-refresh": "redraws a stale home panel after a request; the jobs here make no requests",
  "home-last": "redraws a home panel after a request; the jobs here make no requests",
  "disk-walk": "walks one spawn directory for its size: I/O, after a request",
  "bucket-watch": "reads the snapshot lanes in the bucket: network, off without a bucket",
  routines: "a closure in startRoutines; the fixture has no routines",
  "early-watch": "watches one run's branch for an early look; needs a running crew run",
  "release-prove": "proves a release against its serving copy: cluster and network",
  "egress-idle": "a closure in the egress proxy over its live connections; needs the proxy's unix socket",
  "git-readers": "closes idle git cat-file readers: a map walk over child processes the fixture has none of",
  "github-traffic": "pulls GitHub's traffic API: network, and off unless a GitHub token is configured",
  presence: "writes this process's heartbeat file under the data directory: one small file write",
  "snapshot-journal": "inside a running snapshot upload: writes its journal; nightly, I/O",
  "snapshot-report": "inside a running snapshot upload: logs its progress; nightly",
  "system-live": "reads /proc and the cgroup roots for the system page while someone watches it",
  entitlements: "reads each paid subscription from Stripe: network, daily, and the fixture has no entitlements",
  traffic: "a closure in createTrafficWriter over its in-memory minute ledger; follow-up",
  "spawn-due-wake": "a timer in the spawn host that wakes a due run: needs a spawned run; the fixture has none",
};

/** A job held past this in one slice fails the test: five times the issue's 50 ms, so no runner flakes it. */
const CEILING_MS = 250;

/** Every name src/ passes to `during`: the list a new job joins, timed or not. */
function duringNames(dir = new URL("../src/", import.meta.url).pathname): Set<string> {
  const names = new Set<string>();
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const m of text.matchAll(/\bduring\(\s*"([^"]+)"/g)) names.add(m[1]!);
  }
  return names;
}

test("every job src/ runs under `during` is timed here or named in UNTIMED with a reason", () => {
  const timed = Object.keys(jobs());
  const named = duringNames();
  expect(named.size).toBeGreaterThan(40);
  const neither = [...named].filter((n) => !timed.includes(n) && !(n in UNTIMED)).sort();
  const both = timed.filter((n) => n in UNTIMED);
  const gone = [...timed, ...Object.keys(UNTIMED)].filter((n) => !named.has(n)).sort();
  expect({ neither, both, gone }).toEqual({ neither: [], both: [], gone: [] });
});

test("every timed job's tick holds the loop under the ceiling on a busy fixture, worst first", async () => {
  const measured: { name: string; ms: number }[] = [];
  for (const [name, tick] of Object.entries(jobs())) {
    await slice(tick); // the first tick prepares its statements; the timer's ticks find them warm
    Bun.gc(true); // the fixture's garbage is collected before the clock runs, not charged to whichever job comes first
    measured.push({ name, ms: await slice(tick) });
  }
  measured.sort((a, b) => b.ms - a.ms);
  console.log(`job slices (ms), worst first:\n${measured.map((j) => `  ${j.name}: ${j.ms.toFixed(1)}`).join("\n")}`);
  expect(measured.filter((j) => j.ms >= CEILING_MS)).toEqual([]);
}, 60_000);

test("the memory sampler reads the heap's size without walking the heap", async () => {
  // A heap with many objects on it, as a forge's is after a day of serving.
  const held = Array.from({ length: 300_000 }, (_, i) => ({ i }));
  const memory = startMemorySampler(app, 1e9);
  memory.stop();
  memory.tick();
  // The baseline, in this run on this heap: one walk of it, what the tick did before #11118.
  const walk = await slice(() => heapStats());
  const tick = await slice(() => memory.tick());
  console.log(`memory-sampler on ${held.length} objects: ${tick.toFixed(1)} ms; heapStats() alone: ${walk.toFixed(1)} ms`);
  expect(tick).toBeLessThan(walk / 4);
}, 60_000);
