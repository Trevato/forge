/** Redeploying an environment says why it will not and starts nothing (#7105). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redeployEnv } from "../src/actions/apps.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { listRuns } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let alice: User;
let repo: Repo;

const runs = () => listRuns(app.db, repo.id, { kind: "deploy", limit: 50 }).length;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-redeploy-refusals-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  alice = u.value;
  const made = await createRepo(app, alice, { name: "empty" });
  if (!made.ok) throw new Error(made.error);
  repo = made.value;
  const rec = makeAppRecord(app.db, { repoId: repo.id, slug: "empty", access: "public" });
  if (!rec.ok) throw new Error(rec.error);
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("with no apps runtime, redeploying is no_runtime and creates no run", async () => {
  const before = runs();
  const res = await redeployEnv(app, alice, repo, "production");
  expect(res).toEqual({ ok: false, error: "no_runtime" });
  expect(runs()).toBe(before);
});

test("a name that is no environment is no_such_env, before the runtime is asked", async () => {
  const before = runs();
  for (const name of ["", "staging", "pull-0", "pull-01", "pull-x", "../production", "production "]) {
    expect(await redeployEnv(app, alice, repo, name)).toEqual({ ok: false, error: "no_such_env" });
  }
  expect(runs()).toBe(before);
});

test("with a runtime and no commit yet, redeploying is nothing_to_deploy and creates no run", async () => {
  // Constructed, not started: it registers itself for the app and runs nothing.
  new AppsRuntime(app, { domain: "apps.test", scheme: "http", publicPort: 0, forgeUrl: "http://127.0.0.1:0", concurrency: 1 });
  const before = runs();
  expect(await redeployEnv(app, alice, repo, "production")).toEqual({ ok: false, error: "nothing_to_deploy" });
  // A preview of a pull that does not exist has no commit either.
  expect(await redeployEnv(app, alice, repo, "pull-7")).toEqual({ ok: false, error: "nothing_to_deploy" });
  expect(runs()).toBe(before);
});
