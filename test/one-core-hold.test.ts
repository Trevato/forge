/** #11599: on one CPU a check or a snapshot waits for the crew run; two CPUs start them at once. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { holdClock } from "../src/core/one_core.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let checks: ChecksHandle | undefined;
let snaps: SnapshotsHandle | undefined;
let seeded: { userId: string; repoId: string } | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-one-core-"));
  app = createApp({ dataDir: dir, port: 0 });
});
afterEach(async () => {
  await checks?.stop({ drain: false });
  await snaps?.stop();
  checks = snaps = seeded = undefined;
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 3000): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) if (ok()) return true;
  return ok();
}

async function queuedCheck(opts: { pull?: boolean; env?: string; reason?: string; rebase?: boolean } = {}): Promise<string> {
  if (seeded === undefined) {
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!made.ok) throw new Error(made.error);
    const repo = await createRepo(app, made.value, { name: "lib", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    seeded = { userId: made.value.id, repoId: repo.value.id };
  }
  const issue = createIssue(app.db, { repoId: seeded.repoId, authorId: seeded.userId, title: "change" });
  if (!issue.ok) throw new Error(issue.error);
  if (opts.rebase) createRun(app.db, { repoId: seeded.repoId, kind: "agent", issueId: issue.value.id, reason: "conflict", commitOid: "0".repeat(40) });
  return createRun(app.db, { repoId: seeded.repoId, kind: "check", env: opts.env ?? "", commitOid: "0".repeat(40), reason: opts.reason ?? "test", ...(opts.pull === false ? {} : { issueId: issue.value.id }) }).id;
}

test("1 CPU with a crew run holds a queued check, and it starts once the run is gone", async () => {
  const id = await queuedCheck();
  let crew = 1;
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 1, activeCrewRuns: () => crew, tickMs: 25 });
  await sleep(200);
  expect(getRun(app.db, id)!.state).toBe("queued");
  crew = 0;
  expect(await until(() => getRun(app.db, id)!.state !== "queued")).toBe(true);
});

test("2 CPUs start a queued check at once, whatever the crew does", async () => {
  const id = await queuedCheck();
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 2, activeCrewRuns: () => 1, tickMs: 25 });
  expect(await until(() => getRun(app.db, id)!.state !== "queued")).toBe(true);
});

test("1 CPU with a crew run does not hold a main check, a rebase check or a verify run", async () => {
  const main = await queuedCheck({ pull: false });
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 1, activeCrewRuns: () => 1, tickMs: 25 });
  expect(await until(() => getRun(app.db, main)!.state !== "queued")).toBe(true);
});

test("1 CPU: a verify-lane run starts with a crew run active", async () => {
  const verify = await queuedCheck({ pull: false, env: "verify" });
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 1, activeCrewRuns: () => 1, tickMs: 25 });
  expect(await until(() => getRun(app.db, verify)!.state !== "queued")).toBe(true);
});

test("1 CPU: a rebase's check starts with a crew run active, a pull's check beside it waits", async () => {
  const rebase = await queuedCheck({ rebase: true });
  const pull = await queuedCheck();
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 2, cpus: () => 1, activeCrewRuns: () => 1, tickMs: 25 });
  expect(await until(() => getRun(app.db, rebase)!.state !== "queued")).toBe(true);
  expect(getRun(app.db, pull)!.state).toBe("queued");
});

test("1 CPU: a pull's check held past the maximum wait starts anyway", async () => {
  const id = await queuedCheck();
  let now = 1_000;
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 1, activeCrewRuns: () => 1, tickMs: 25, holdMaxMs: 5_000, holdNow: () => now });
  await sleep(150);
  expect(getRun(app.db, id)!.state).toBe("queued");
  now += 5_000;
  expect(await until(() => getRun(app.db, id)!.state !== "queued")).toBe(true);
});

test("1 CPU: a check held, then idle, is held afresh when the next crew run comes", async () => {
  const id = await queuedCheck();
  let now = 1_000;
  let crew = 1;
  checks = startChecks(app, { forgeUrl: "http://127.0.0.1:9", concurrency: 1, cpus: () => 1, activeCrewRuns: () => crew, tickMs: 25, holdMaxMs: 5_000, holdNow: () => now });
  await sleep(100);
  expect(getRun(app.db, id)!.state).toBe("queued");
  // Kept queued by something else (a not-before) while no crew run works.
  app.db.run("UPDATE run SET not_before = ? WHERE id = ?", [new Date(Date.now() + 60_000).toISOString(), id]);
  now += 4_000;
  crew = 0;
  await sleep(100);
  // The crew returns past the first clock's bound: a fresh hold, not a release.
  crew = 1;
  now += 2_000;
  app.db.run("UPDATE run SET not_before = NULL WHERE id = ?", [id]);
  await sleep(150);
  expect(getRun(app.db, id)!.state).toBe("queued");
  now += 5_000;
  expect(await until(() => getRun(app.db, id)!.state !== "queued")).toBe(true);
});

test("the hold clock releases work after its maximum, and a started key begins again", () => {
  const c = holdClock(100);
  expect(c.held("a", 0)).toBe(true);
  expect(c.held("a", 99)).toBe(true);
  expect(c.held("a", 100)).toBe(false);
  c.release("a");
  expect(c.held("a", 500)).toBe(true);
});

test("the hold clock starts again after reset, and keep forgets work no longer waiting", () => {
  const c = holdClock(100);
  c.held("a", 0);
  c.held("b", 0);
  c.reset();
  expect(c.held("a", 150)).toBe(true);
  c.held("b", 150);
  c.keep(new Set(["a"]));
  expect(c.held("a", 250)).toBe(false);
  expect(c.held("b", 260)).toBe(true);
});

// The timers are set far off: each test drives `takeIfDue` itself, with an injected clock.
function snapshotRuns(cpus: number, crew: () => number, extra: { holdMaxMs?: number; now?: () => number } = {}) {
  snaps = startSnapshots(app, dirStore(join(dir, "store")), {
    version: "t",
    cpus: () => cpus,
    activeCrewRuns: crew,
    snapshotCatchUpMs: 3_600_000,
    snapshotCheckMs: 3_600_000,
    holdRetryMs: 3_600_000,
    catchUpMs: 3_600_000,
    mirrorEveryMs: 3_600_000,
    nightly: false,
    ...extra,
  });
  return snaps;
}

test("1 CPU with a crew run holds a due snapshot, and takes it once the run is gone", async () => {
  let crew = 1;
  const s = snapshotRuns(1, () => crew);
  expect(await s.takeIfDue()).toBe(false);
  expect((await s.list()).length).toBe(0);
  crew = 0;
  expect(await s.takeIfDue()).toBe(true);
  expect(s.last().manifest).toBeDefined();
});

test("1 CPU: a snapshot held past the maximum wait is taken anyway", async () => {
  let now = 1_000;
  const s = snapshotRuns(1, () => 1, { holdMaxMs: 5_000, now: () => now });
  expect(await s.takeIfDue()).toBe(false);
  now += 4_999;
  expect(await s.takeIfDue()).toBe(false);
  now += 1;
  expect(await s.takeIfDue()).toBe(true);
  expect(s.last().manifest).toBeDefined();
});

test("2 CPUs take a due snapshot at once, without asking about crew runs", async () => {
  let asked = 0;
  const s = snapshotRuns(2, () => (asked++, 1));
  expect(await s.takeIfDue()).toBe(true);
  expect(s.last().manifest).toBeDefined();
  expect(asked).toBe(0);
});
