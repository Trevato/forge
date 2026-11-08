/**
 * The deploys screen's `b` serves a commit as a build preview (`previewBuild`):
 * offered to a writer who is a person, it takes a full commit id, says the
 * address on success and the refusal in words otherwise, and calls nothing
 * for a malformed id. The runtime's `previewBuild` is faked.
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
import { repoDir } from "../src/git/repos.ts";
import { gitClientEnv } from "./helpers/git-client.ts";
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
let state: EnvStatus["state"];
let deploys: string[];
let stops: string[];
let builds: string[];
let sha = "";

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
  sha = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: repoDir(forge.reposRoot, "alice", "lamp"), env: gitClientEnv() }).stdout.toString().trim();
  const made = createAppRecord(forge.db, { repoId: repo.id, slug: "lamp", access: "public" });
  if (!made.ok) throw new Error(made.error);
  runtime = new AppsRuntime(forge, { domain: "apps.test", scheme: "https", forgeUrl: "https://forge.test", concurrency: 1 });
  runtime.status = (() => [{ env: "production", state } as EnvStatus]) as typeof runtime.status;
  runtime.requestDeploy = ((_record, _repo, env) => {
    deploys.push(env);
    return { id: "run-1" } as Run;
  }) as typeof runtime.requestDeploy;
  runtime.previewBuild = (async (_record, _repo, oid) => {
    builds.push(oid);
    return { env: `build-${oid.slice(0, 7)}`, run: undefined };
  }) as typeof runtime.previewBuild;
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
  builds = [];
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

test("b asks for a commit id and serves it, saying where", async () => {
  const h = await open(alice);
  expect(h.keys()).toContain("preview a commit");
  await h.press("b");
  expect(h.text()).toContain("Commit id");
  for (const ch of sha) await h.press(ch);
  await h.press("enter");
  expect(builds).toEqual([sha]);
  expect(h.toasts.at(-1)?.text).toContain(`Previewing ${sha.slice(0, 7)} at `);
  expect(h.toasts.at(-1)?.text).toContain(`lamp--b${sha.slice(0, 7)}.apps.test`);
  h.app.stop();
});

test("a malformed id keeps the prompt open and asks for nothing", async () => {
  const h = await open(alice);
  await h.press("b", "x", "enter");
  expect(h.text()).toContain("Give the full 40-character commit id.");
  expect(builds).toEqual([]);
  h.app.stop();
});

test("a reader is offered no key and pressing it does nothing", async () => {
  const h = await open(bob);
  expect(h.keys()).not.toContain("preview a commit");
  await h.press("b");
  expect(h.text()).not.toContain("Commit id");
  expect(builds).toEqual([]);
  h.app.stop();
});

test("a writer who is unverified is told to verify, and nothing is served", async () => {
  forge.db.query("UPDATE email_check SET verified_at = NULL WHERE user_id = ?1").run(alice.id);
  try {
    const h = await open(alice);
    await h.press("b");
    for (const ch of sha) await h.press(ch);
    await h.press("enter");
    expect(builds).toEqual([]);
    expect(h.toasts.at(-1)).toEqual({ text: expect.stringContaining("Verify your email first"), tone: "danger" });
    h.app.stop();
  } finally {
    markVerified(forge.db, alice.id, new Date().toISOString());
  }
});
