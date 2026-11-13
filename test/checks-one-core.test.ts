/**
 * One core (#11561): a 1-CPU forge starts no pull check while a crew run is
 * active, and starts it once the run is gone; main's check is never held.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { startChecks, type ChecksHandle } from "../src/checks/service.ts";
import { createRun, getRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";

let dir = "";
let app: App | undefined;
let checks: ChecksHandle | undefined;

afterEach(async () => {
  await checks?.stop();
  checks = undefined;
  app?.db.close();
  app = undefined;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), "forge-onecore-"));
  app = createApp({ dataDir: dir, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "lib" });
  if (!made.ok) throw new Error(String(made.error));
  const first = await commitToBranch(app, u.value, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "x\n" }],
  });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const c = await commitToBranch(app, u.value, made.value, {
    branch: "one",
    message: "one",
    files: [{ path: "one.md", content: "x\n" }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  const o = await openPull(app, u.value, made.value, {
    title: "one",
    baseBranch: "main",
    headBranch: "one",
  });
  if (!o.ok) throw new Error(String(o.error));
  return { app, repoId: made.value.id, pullId: o.value.id };
}

const left = (a: App, id: string): boolean => getRun(a.db, id)?.state === "queued";

describe("checks on one core", () => {
  test("1 CPU with a crew run holds a pull's check, and it starts once the run is gone", async () => {
    // Invariant: crewHoldsCore holds queued pull checks, and releases them when the run ends.
    const { app: a, repoId, pullId } = await setup();
    let active = 1;
    const run = createRun(a.db, { repoId, kind: "check", env: "pull-1", issueId: pullId });
    checks = startChecks(a, {
      forgeUrl: "http://localhost",
      cpus: () => 1,
      activeCrewRuns: () => active,
    });
    await Bun.sleep(150);
    expect(left(a, run.id)).toBe(true);
    active = 0;
    // The tick (or a gate's release) schedules again; the check leaves the queue.
    const deadline = Date.now() + 8_000;
    while (left(a, run.id) && Date.now() < deadline) await Bun.sleep(25);
    expect(left(a, run.id)).toBe(false);
  }, 15_000);

  test("2 CPUs start a pull's check at once, a crew run or not", async () => {
    // Invariant: only a 1-CPU forge holds.
    const { app: a, repoId, pullId } = await setup();
    const run = createRun(a.db, { repoId, kind: "check", env: "pull-1", issueId: pullId });
    checks = startChecks(a, {
      forgeUrl: "http://localhost",
      cpus: () => 2,
      activeCrewRuns: () => 1,
    });
    const deadline = Date.now() + 4_000;
    while (left(a, run.id) && Date.now() < deadline) await Bun.sleep(10);
    expect(left(a, run.id)).toBe(false);
  });

  test("main's check, the merge gate, starts on 1 CPU while a crew run is active", async () => {
    // Invariant: the hold never reaches a check with no pull, so a red main is not held forever.
    const { app: a, repoId } = await setup();
    const run = createRun(a.db, { repoId, kind: "check", env: "main" });
    checks = startChecks(a, {
      forgeUrl: "http://localhost",
      cpus: () => 1,
      activeCrewRuns: () => 1,
    });
    const deadline = Date.now() + 4_000;
    while (left(a, run.id) && Date.now() < deadline) await Bun.sleep(10);
    expect(left(a, run.id)).toBe(false);
  });
});
