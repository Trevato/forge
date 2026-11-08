/**
 * A run's home (`<id>.home`) belongs to run `<id>` (#7545): the sweep removes
 * it once the run is finished or its lease lapsed, leaves a live run's alone,
 * and removes it even with read-only files in it. A torn-down preview takes
 * its home with it. A gate writes no run: its checkout and home stay while
 * its `check_gate` row is open, and go once it closes or outlives any check
 * (#7673).
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { requeueAbandonedChecks, sweepCheckouts, sweepSoon } from "../src/checks/service.ts";
import { beginGate, endGate } from "../src/checks/gate_record.ts";
import { ensureEnvData, removeEnv } from "../src/apps/data.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { GATE_DEADLINE_MS, gateRunId } from "../src/checks/queue.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import { createUser } from "../src/core/users.ts";

let app: App;
let dataDir: string;
let repoId: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "forge-home-sweep-"));
  app = createApp({ dataDir, port: 0 });
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await createRepo(app, a.value, { name: "garden", visibility: "private" });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  repoId = made.value.id;
});
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

const home = (id: string): string => join(dataDir, "checks", `${id}.home`);
const populate = (id: string, readOnly = false): void => {
  const deep = join(home(id), ".bun", "install", "cache");
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(deep, "pkg"), "x");
  if (readOnly) {
    chmodSync(join(deep, "pkg"), 0o444);
    chmodSync(deep, 0o555);
  }
};
const run = () => createRun(app.db, { repoId, kind: "check", env: "x", commitOid: "a".repeat(40) });

test("a finished run's home is removed, a live run's survives", async () => {
  const live = run();
  claimRun(app.db, live.id);
  const done = run();
  claimRun(app.db, done.id);
  finishRun(app.db, done.id, { state: "ok", summary: "ok" });
  populate(live.id);
  populate(done.id);
  populate("no-such-run");
  await sweepCheckouts(app);
  expect(existsSync(home(live.id))).toBe(true);
  expect(existsSync(home(done.id))).toBe(false);
  expect(existsSync(home("no-such-run"))).toBe(false);
});

test("the abandoned-checks timer sweeps a finished run's home, not a live one's", async () => {
  const live = run();
  claimRun(app.db, live.id);
  const done = run();
  claimRun(app.db, done.id);
  finishRun(app.db, done.id, { state: "ok", summary: "ok" });
  populate(live.id);
  populate(done.id);
  requeueAbandonedChecks(app, STALE_AFTER_MS);
  // Removal is off the loop (#7688): the call returned with the home still there.
  expect(existsSync(home(done.id))).toBe(true);
  await sweepSoon(app);
  expect(existsSync(home(live.id))).toBe(true);
  expect(existsSync(home(done.id))).toBe(false);
});

test("sweeping a checkout hands the loop back before it finishes (#7688)", async () => {
  const done = run();
  claimRun(app.db, done.id);
  finishRun(app.db, done.id, { state: "ok", summary: "ok" });
  populate(done.id);
  const sweep = sweepSoon(app);
  expect(existsSync(home(done.id))).toBe(true);
  await sweep;
  expect(existsSync(home(done.id))).toBe(false);
});

test("the timer leaves a running gate's checkout and home alone, and removes them once no gate could be using them", async () => {
  const root = join(dataDir, "checks");
  const dir = join(root, "gate-0123456789ab");
  const home = `${dir}.home`;
  mkdirSync(dir, { recursive: true });
  mkdirSync(home, { recursive: true });
  requeueAbandonedChecks(app, STALE_AFTER_MS);
  expect(existsSync(dir)).toBe(true);
  expect(existsSync(home)).toBe(true);
  await sweepCheckouts(app, Date.now() + GATE_DEADLINE_MS + 60_000);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(home)).toBe(false);
});

test("a lapsed run's home is removed", async () => {
  const r = run();
  claimRun(app.db, r.id);
  populate(r.id);
  await sweepCheckouts(app, Date.now() + 24 * 3600_000);
  expect(existsSync(home(r.id))).toBe(false);
});

test("a home with a read-only file is still removed", async () => {
  const r = run();
  claimRun(app.db, r.id);
  finishRun(app.db, r.id, { state: "failed", summary: "red" });
  populate(r.id, true);
  await sweepCheckouts(app);
  expect(existsSync(home(r.id))).toBe(false);
});

test("tearing a preview down removes its home", async () => {
  ensureEnvData(dataDir, "app1", "pull-1", "empty");
  const h = join(dataDir, "apps", "app1", "pull-1", "home");
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "cache"), "x");
  removeEnv(dataDir, "app1", "pull-1");
  expect(existsSync(h)).toBe(false);
});

test("a gate's open row keeps its checkout and home past the deadline window; a finished gate's go", async () => {
  const running = "b".repeat(40);
  const finished = "c".repeat(40);
  const open = beginGate(app.db, repoId, undefined, running);
  endGate(app.db, beginGate(app.db, repoId, undefined, finished));
  for (const oid of [running, finished]) {
    mkdirSync(join(dataDir, "checks", gateRunId(oid), "node_modules"), { recursive: true });
    populate(gateRunId(oid));
  }
  // Past the young-checkout window a full suite still runs: the open row holds it.
  await sweepCheckouts(app, Date.now() + GATE_DEADLINE_MS + 60_000);
  expect(existsSync(join(dataDir, "checks", gateRunId(running), "node_modules"))).toBe(true);
  expect(existsSync(home(gateRunId(running)))).toBe(true);
  expect(existsSync(join(dataDir, "checks", gateRunId(finished)))).toBe(false);
  expect(existsSync(home(gateRunId(finished)))).toBe(false);
  // A row a crash left open holds no longer than a check may run.
  await sweepCheckouts(app, Date.now() + 3 * 3600_000);
  expect(existsSync(join(dataDir, "checks", gateRunId(running)))).toBe(false);
  endGate(app.db, open);
});
