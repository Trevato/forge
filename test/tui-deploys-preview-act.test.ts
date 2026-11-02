/**
 * The deploys screen redeploys and stops the selected preview with `D` and
 * `S` after a `y/n` confirm naming the pull; a reader is offered neither key,
 * and a stopped preview offers only `D`.
 */

import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import type { Run } from "../src/core/runs.ts";
import type { User } from "../src/core/users.ts";
import { markVerified } from "../src/core/verify.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let forge: Forge;
let runtime: AppsRuntime;
let alice: User;
let bob: User;
let repo: Repo;
let previewState: EnvStatus["state"];
let deploys: string[];
let stops: string[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-preview-act-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(forge, { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  proveAll(forge);
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  const committed = await commitToBranch(forge, alice, repo, {
    message: "Light the lamp",
    files: [{ path: "README.md", content: "lamp\n" }],
  });
  if (!committed.ok) throw new Error(JSON.stringify(committed.error));
  const made = createAppRecord(forge.db, { repoId: repo.id, slug: "lamp", access: "public" });
  if (!made.ok) throw new Error(made.error);
  const id = crypto.randomUUID();
  forge.db
    .query("INSERT INTO issue (id, repo_id, number, kind, title, author_id) VALUES (?, ?, 7, 'pull', 'Brighter wick', ?)")
    .run(id, repo.id, alice.id);
  forge.db
    .query("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?, 'main', 'wick', 'b', 'h')")
    .run(id);
  runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  runtime.status = (() => [
    { env: "production", state: "running", url: "https://lamp.apps.test", commitOid: "a".repeat(40) } as EnvStatus,
    { env: "pull-7", state: previewState, url: "https://lamp--7.apps.test", commitOid: "a".repeat(40) } as EnvStatus,
  ]) as typeof runtime.status;
  runtime.requestDeploy = ((_record, _repo, env) => {
    deploys.push(env);
    return { id: "run-1" } as Run;
  }) as typeof runtime.requestDeploy;
  runtime.stopEnv = (async (_record, env) => {
    stops.push(env);
    previewState = "stopped";
  }) as typeof runtime.stopEnv;
});
afterAll(async () => {
  await runtime.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  previewState = "running";
  deploys = [];
  stops = [];
});

const open = async (who: User) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(200, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const screen = deploysScreen(session, app.ctx, repo);
  app.push(screen);
  await settleApp(app);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, press, keys: () => screen.keys.map((k) => k.help), text: () => app.screen.toText() };
};

test("a writer stops a preview with S and y; the runtime saw that env", async () => {
  const h = await open(alice);
  // No deploys, so the cursor is already among the previews.
  await h.press("j");
  expect(h.keys()).toContain("redeploy preview");
  expect(h.keys()).toContain("stop preview");
  expect(h.keys()).not.toContain("stop production");
  await h.press("S");
  expect(h.text()).toContain("stop #7's preview? y/n");
  await h.press("y");
  expect(stops).toEqual(["pull-7"]);
  expect(h.text()).toContain("Stopped preview of #7.");
  // Stopped: only redeploy is left.
  expect(h.keys()).toContain("redeploy preview");
  expect(h.keys()).not.toContain("stop preview");
  h.app.stop();
});

test("D and y redeploys the preview; n changes nothing", async () => {
  const h = await open(alice);
  await h.press("j", "D");
  expect(h.text()).toContain("redeploy #7's preview? y/n");
  await h.press("n");
  expect(deploys).toEqual([]);
  await h.press("S", "n");
  expect(stops).toEqual([]);
  await h.press("D", "y");
  expect(deploys).toEqual(["pull-7"]);
  expect(h.text()).toContain("Redeploying preview of #7.");
  h.app.stop();
});

test("a reader is offered neither key", async () => {
  const h = await open(bob);
  await h.press("j");
  expect(h.keys().filter((k) => /^(redeploy|stop) /.test(k))).toEqual([]);
  await h.press("D", "S");
  expect(h.text()).not.toContain("preview? y/n");
  expect(deploys).toEqual([]);
  expect(stops).toEqual([]);
  h.app.stop();
});

test("a refused preview action toasts in red and calls nothing", async () => {
  forge.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = ?1").run(alice.id);
  try {
    const h = await open(alice);
    await h.press("j", "D", "y");
    expect(deploys).toEqual([]);
    expect(h.text()).toContain("Verify your email first");
    h.app.stop();
  } finally {
    markVerified(forge.db, alice.id, new Date().toISOString());
  }
});

test("on a deploy row, D and S still act on production", async () => {
  const h = await open(alice);
  expect(h.keys()).toContain("redeploy production");
  expect(h.keys()).not.toContain("redeploy preview");
  await h.press("D");
  expect(h.text()).toContain("Redeploy production of alice/lamp?");
  await h.press("enter");
  expect(deploys).toEqual(["production"]);
  await h.press("S", "enter");
  expect(stops).toEqual(["production"]);
  h.app.stop();
});
