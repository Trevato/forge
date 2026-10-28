/**
 * A run's home (`<id>.home`) belongs to run `<id>` (#7545): the sweep removes
 * it once the run is finished or its lease lapsed, leaves a live run's alone,
 * and removes it even with read-only files in it. A torn-down preview takes
 * its home with it.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { requeueAbandonedChecks, sweepCheckouts } from "../src/checks/service.ts";
import { ensureEnvData, removeEnv } from "../src/apps/data.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
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

test("a finished run's home is removed, a live run's survives", () => {
  const live = run();
  claimRun(app.db, live.id);
  const done = run();
  claimRun(app.db, done.id);
  finishRun(app.db, done.id, { state: "ok", summary: "ok" });
  populate(live.id);
  populate(done.id);
  populate("no-such-run");
  sweepCheckouts(app);
  expect(existsSync(home(live.id))).toBe(true);
  expect(existsSync(home(done.id))).toBe(false);
  expect(existsSync(home("no-such-run"))).toBe(false);
});

test("the abandoned-checks timer sweeps a finished run's home, not a live one's", () => {
  const live = run();
  claimRun(app.db, live.id);
  const done = run();
  claimRun(app.db, done.id);
  finishRun(app.db, done.id, { state: "ok", summary: "ok" });
  populate(live.id);
  populate(done.id);
  requeueAbandonedChecks(app, STALE_AFTER_MS);
  expect(existsSync(home(live.id))).toBe(true);
  expect(existsSync(home(done.id))).toBe(false);
});

test("a lapsed run's home is removed", () => {
  const r = run();
  claimRun(app.db, r.id);
  populate(r.id);
  sweepCheckouts(app, Date.now() + 24 * 3600_000);
  expect(existsSync(home(r.id))).toBe(false);
});

test("a home with a read-only file is still removed", () => {
  const r = run();
  claimRun(app.db, r.id);
  finishRun(app.db, r.id, { state: "failed", summary: "red" });
  populate(r.id, true);
  sweepCheckouts(app);
  expect(existsSync(home(r.id))).toBe(false);
});

test("tearing a preview down removes its home", () => {
  ensureEnvData(dataDir, "app1", "pull-1", "empty");
  const h = join(dataDir, "apps", "app1", "pull-1", "home");
  mkdirSync(h, { recursive: true });
  writeFileSync(join(h, "cache"), "x");
  removeEnv(dataDir, "app1", "pull-1");
  expect(existsSync(h)).toBe(false);
});
