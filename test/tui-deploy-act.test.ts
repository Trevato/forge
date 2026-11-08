/**
 * The deploys screen redeploys and stops production (#7231): `D` and `S`,
 * each after a one-line confirm, through `redeployEnv` and `stopEnv`, told in
 * the page's words. A reader sees neither key; a stopped production offers
 * redeploy only, a refusal toasts in red in the page's words, and a writer
 * whose repository has no app is offered neither key. The runtime is constructed, not started, with its deploy,
 * stop and status faked, as `tui-deploys.test.ts` fakes `envStatus`.
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
let empty: Repo;
let unserved: Repo;
let state: EnvStatus["state"];
let deploys: string[];
let stops: string[];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploy-act-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(
    forge,
    { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" },
    { slot: fixtureSlot(forge) },
  );
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
  // An app whose repository has no commit yet: a redeploy has nothing to deploy.
  const e = await createRepo(forge, alice, { name: "dark", visibility: "public" });
  if (!e.ok) throw new Error("repo failed");
  empty = e.value;
  const dark = createAppRecord(forge.db, { repoId: empty.id, slug: "dark", access: "public" });
  if (!dark.ok) throw new Error(dark.error);
  // A repository alice writes to that is no app at all.
  const u = await createRepo(forge, alice, { name: "unlit", visibility: "public" });
  if (!u.ok) throw new Error("repo failed");
  unserved = u.value;
  runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  runtime.status = (() => [{ env: "production", state } as EnvStatus]) as typeof runtime.status;
  runtime.requestDeploy = ((_record, _repo, env) => {
    deploys.push(env);
    return { id: "run-1" } as Run;
  }) as typeof runtime.requestDeploy;
  runtime.stopEnv = (async (_record, env) => {
    stops.push(env);
    state = "stopped";
  }) as typeof runtime.stopEnv;
});
afterAll(async () => {
  await runtime.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  state = "running";
  deploys = [];
  stops = [];
});

const open = async (who: User, of: Repo = repo) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(200, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const toasts: { text: string; tone: string | undefined }[] = [];
  const toast = app.toast.bind(app);
  app.toast = (text, tone) => {
    toasts.push({ text, tone });
    toast(text, tone);
  };
  const screen = deploysScreen(session, app.ctx, of);
  app.push(screen);
  await settleApp(app);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  const keys = () => screen.keys.map((b) => b.help);
  return { app, press, keys, toasts, text: () => app.screen.toText() };
};

test("D asks a confirm naming the app and production, then redeploys and says so", async () => {
  const h = await open(alice);
  expect(h.text()).toContain("D  redeploy production");
  await h.press("D");
  expect(h.text()).toContain("Redeploy production of alice/lamp?");
  expect(deploys).toEqual([]);
  await h.press("enter");
  expect(deploys).toEqual(["production"]);
  expect(h.text()).toContain("Redeploying production.");
  h.app.stop();
});

test("cancelling the confirm calls nothing", async () => {
  const h = await open(alice);
  await h.press("D");
  await h.press("esc");
  await h.press("S");
  expect(h.text()).toContain("Stop production of alice/lamp?");
  await h.press("left", "enter");
  expect(deploys).toEqual([]);
  expect(stops).toEqual([]);
  h.app.stop();
});

test("S stops production, the state reads stopped, and only redeploy is left", async () => {
  const h = await open(alice);
  expect(h.text()).toContain("production deploys · running");
  await h.press("S", "enter");
  expect(stops).toEqual(["production"]);
  const text = h.text();
  expect(text).toContain("Stopped production. Its data is kept; Redeploy brings it back.");
  expect(text).toContain("production deploys · stopped");
  expect(h.keys()).toContain("redeploy production");
  expect(h.keys()).not.toContain("stop production");
  await h.press("S");
  expect(h.text()).not.toContain("Stop production of");
  h.app.stop();
});

test("a reader sees neither key, and pressing them does nothing", async () => {
  const h = await open(bob);
  const text = h.text();
  expect(text).not.toContain("redeploy production");
  expect(text).not.toContain("stop production");
  expect(h.keys()).not.toContain("redeploy production");
  expect(h.keys()).not.toContain("stop production");
  await h.press("D");
  await h.press("S");
  expect(h.text()).not.toContain("of alice/lamp?");
  expect(deploys).toEqual([]);
  expect(stops).toEqual([]);
  h.app.stop();
});

test("a refused redeploy toasts in red in the page's words and deploys nothing", async () => {
  const h = await open(alice, empty);
  await h.press("D");
  expect(h.text()).toContain("Redeploy production of alice/dark?");
  await h.press("enter");
  expect(deploys).toEqual([]);
  const nothing = "There is nothing to deploy: the branch has no commits, or the pull request is closed.";
  expect(h.toasts).toEqual([{ text: nothing, tone: "danger" }]);
  expect(h.text()).toContain(nothing);
  h.app.stop();
});

test("a writer whose email is unverified is told to verify it, and nothing deploys", async () => {
  forge.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = ?1").run(alice.id);
  try {
    const h = await open(alice);
    await h.press("D", "enter");
    expect(deploys).toEqual([]);
    const verify = "Verify your email first: open the link the forge mailed you, or ask for another from your account settings.";
    expect(h.toasts).toEqual([{ text: verify, tone: "danger" }]);
    expect(h.text()).toContain(verify);
    h.app.stop();
  } finally {
    markVerified(forge.db, alice.id, new Date().toISOString());
  }
});

test("a writer whose repository is no app is offered neither key", async () => {
  const h = await open(alice, unserved);
  expect(h.keys()).not.toContain("redeploy production");
  expect(h.keys()).not.toContain("stop production");
  await h.press("D");
  await h.press("S");
  expect(h.text()).not.toContain("of alice/unlit?");
  expect(deploys).toEqual([]);
  expect(stops).toEqual([]);
  h.app.stop();
});
