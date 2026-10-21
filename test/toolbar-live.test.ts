/** The production toolbar page names the commit that is live (#4089); previews do not. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, markServing } from "../src/core/runs.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { commitLog } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";
let oid = "";
let subject = "";

const toolbar = async (env = "production", signedIn = true): Promise<string> =>
  (await fetch(`${servers.url}/alice/forge/toolbar?env=${env}`, { headers: signedIn ? { cookie } : {} })).text();

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-toolbar-live-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
    password: "a-good-passphrase", adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const made = await newApp(app, { id: u.value.id, username: "alice" } as never, { name: "forge", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(made.error);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST", headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }), redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const repo = getRepo(app.db, "alice", "forge")!;
  repoId = repo.id;
  const log = await commitLog(repoDir(app.reposRoot, "alice", "forge"), repo.defaultBranch, { limit: 1 });
  if (!log.ok) throw new Error("no commit");
  oid = log.value[0]!.oid;
  subject = log.value[0]!.subject;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("an app never deployed shows no live line", async () => {
  expect(await toolbar()).not.toContain("data-live");
});

test("a deployed app shows its commit, and a newer deploy in flight", async () => {
  const run = createRun(app.db, { repoId, kind: "deploy", env: "production", commitOid: oid });
  claimRun(app.db, run.id);
  markServing(app.db, run.id);
  const page = await toolbar();
  expect(page).toContain("data-live");
  expect(page).toContain(`/commit/${oid}`);
  expect(page).toContain(oid.slice(0, 7));
  expect(page).toContain(subject);
  expect(page).toContain("just now");
  expect(page).not.toContain("is deploying");
  expect(await toolbar("production", false)).toContain("data-live");
  expect(await toolbar("pull-1")).not.toContain("data-live");
  createRun(app.db, { repoId, kind: "deploy", env: "production", commitOid: "b".repeat(40) });
  expect(await toolbar()).toContain("a newer commit is deploying");
});
