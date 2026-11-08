/**
 * The last free check slot belongs to a merge-queue gate (#6376), from the
 * time its candidate forms until its verdict: a pull's check waits for it,
 * a rebase's check and main's check do not, and with no gate every slot is
 * the checks'. The gates are real `enqueue` calls; the service schedules
 * once as it starts, and the tests wait on a run's state or a gate's own
 * promise, never on a fixed delay.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { openPull } from "../src/actions/pulls.ts";
import { type Candidate, enqueue, gateQueued, gatesInFlight, type Queued } from "../src/checks/queue.ts";
import { startChecks } from "../src/checks/service.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { cancelRun, createRun, getRun, type Run } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let pulls = 0;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-gate-last-slot-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const made = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  const seeded = await commitToBranch(app, alice, repo, {
    message: "Start",
    files: [{ path: "README.md", content: "# lib\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function newPull(): Promise<Pull> {
  const branch = `b${++pulls}`;
  const branched = await commitToBranch(app, alice, repo, {
    branch,
    message: `Add ${branch}`,
    files: [{ path: `${branch}.md`, content: "ok\n" }],
  });
  if (!branched.ok) throw new Error(JSON.stringify(branched.error));
  const opened = await openPull(app, alice, repo, { title: branch, baseBranch: "main", headBranch: branch });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
}

const pullCheck = (pull: Pull): Run =>
  createRun(app.db, { repoId: repo.id, kind: "check", env: `pull-${pull.number}`, issueId: pull.id, commitOid: pull.headOid });

/** A gate whose candidate cannot be built: it is forming now, and over in a moment. */
function formingGate(pull: Pull): Promise<boolean[]> {
  const entry: Queued = {
    pull,
    dir: join(dataDir, "nowhere"),
    land: async () => undefined,
    release: () => {},
    handBack: () => {},
  };
  const answer = enqueue(`gate-${pull.id}`, [entry], async () => ({ lands: false, interrupted: true }));
  expect(gateQueued()).toBe(true);
  return answer;
}

/** Poll until `ok`, giving up at a generous deadline rather than asserting a speed. */
async function until(ok: () => boolean): Promise<boolean> {
  for (let i = 0; i < 2000 && !ok(); i++) await Bun.sleep(5);
  return ok();
}

const state = (run: Run): Run["state"] => getRun(app.db, run.id)!.state;

/** Whether `run` leaves the queue once the service, with one slot, has had its turn. */
async function starts(run: Run, gate: Promise<boolean[]> | undefined): Promise<boolean> {
  const checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
  try {
    await gate;
    return await until(() => state(run) !== "queued");
  } finally {
    await checks.stop({ drain: false });
    cancelRun(app.db, run.id);
  }
}

test("a pull's check does not take the last slot while a gate is forming", async () => {
  const run = pullCheck(await newPull());
  const gate = formingGate(await newPull());
  const checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
  try {
    // The service scheduled as it started, with the gate's candidate forming.
    expect(state(run)).toBe("queued");
    await gate;
    expect(await until(() => state(run) !== "queued")).toBe(true);
  } finally {
    await checks.stop({ drain: false });
    cancelRun(app.db, run.id);
  }
  expect(gateQueued()).toBe(false);
});

test("a gate that is running keeps the slot: the pull's check starts when it settles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-gate-last-slot-git-"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();
  Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
  git("commit", "-q", "--allow-empty", "-m", "start");
  git("checkout", "-q", "-b", "feature");
  await Bun.write(join(dir, "f.txt"), "f\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "f");
  const headOid = git("rev-parse", "HEAD");
  git("checkout", "-q", "--detach", "main");

  const gated = Promise.withResolvers<void>();
  let running = false;
  const entry: Queued = {
    pull: { id: "gate-running", number: 9999, baseBranch: "main", headOid } as Pull,
    dir,
    land: async () => undefined,
    release: () => {},
    handBack: () => {},
  };
  const answer = enqueue("gate-running-line", [entry], async (_candidate: Candidate) => {
    running = true;
    await gated.promise;
    return { lands: false, interrupted: true };
  });
  const run = pullCheck(await newPull());
  let checks: ReturnType<typeof startChecks> | undefined;
  try {
    expect(await until(() => running)).toBe(true);
    // The candidate is built and the gate runs: nothing is forming, a gate is in flight.
    expect(gateQueued()).toBe(false);
    expect(gatesInFlight()).toBe(1);
    checks = startChecks(app, { forgeUrl: servers.url, concurrency: 1 });
    // The service scheduled as it started, and the one slot is the gate's.
    expect(state(run)).toBe("queued");
    await Bun.sleep(0);
    expect(state(run)).toBe("queued");
    gated.resolve();
    await answer;
    expect(await until(() => state(run) !== "queued")).toBe(true);
  } finally {
    gated.resolve();
    await answer;
    await checks?.stop({ drain: false });
    cancelRun(app.db, run.id);
    await rm(dir, { recursive: true, force: true });
  }
  expect(gatesInFlight()).toBe(0);
});

test("with no gate forming, the pull's check takes the slot", async () => {
  const run = pullCheck(await newPull());
  expect(gateQueued()).toBe(false);
  expect(await starts(run, undefined)).toBe(true);
});

test("a rebase's check and main's check still start while a gate is forming", async () => {
  const pull = await newPull();
  createRun(app.db, { repoId: repo.id, kind: "agent", issueId: pull.id, reason: "conflict" });
  const rebase = pullCheck(pull);
  expect(await starts(rebase, formingGate(await newPull()))).toBe(true);

  const main = createRun(app.db, { repoId: repo.id, kind: "check", env: "main", commitOid: pull.headOid });
  expect(await starts(main, formingGate(await newPull()))).toBe(true);
});
