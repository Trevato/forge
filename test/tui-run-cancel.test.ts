/** The terminal's runs list cancels a queued or running run with `x` and a confirm (#7230). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { claimRun, createRun, finishRun, getRun, type RunKind } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { runsScreen } from "../src/tui/screens/runs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-run-cancel-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.test",
    password: "a-long-passphrase",
  });
  if (!b.ok) throw new Error("bob failed");
  bob = b.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

async function open(user: User, make: (repo: Repo) => string) {
  const r = await createRepo(forge, alice, { name: `lamp${n++}`, visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const runId = make(r.value);
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(runsScreen(session, app.ctx, r.value));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  const hints = () => app.screen.toText();
  return { app, press, runId, hints };
}

const queued = (kind: RunKind = "deploy") => (repo: Repo) =>
  createRun(forge.db, { repoId: repo.id, kind, env: "production" }).id;
const state = (id: string) => getRun(forge.db, id)!.state;

test("x asks, yes cancels the run and the row reads cancelled", async () => {
  const h = await open(alice, queued());
  expect(h.hints()).toMatch(/x +cancel/);
  let text = await h.press("x");
  expect(text).toContain("Cancel run");
  expect(text).toContain("deploy production");
  expect(state(h.runId)).toBe("queued");
  await h.press("left"); // Keep -> Cancel run
  text = await h.press("enter");
  expect(state(h.runId)).toBe("cancelled");
  expect(text).toContain("cancelled");
  h.app.stop();
});

test("declining the confirm leaves the run as it was", async () => {
  const h = await open(alice, queued());
  await h.press("x");
  await h.press("enter"); // defaults to Keep
  expect(state(h.runId)).toBe("queued");
  await h.press("x");
  await h.press("esc");
  expect(state(h.runId)).toBe("queued");
  h.app.stop();
});

test("a running run offers x cancel too", async () => {
  const h = await open(alice, (repo) => {
    const run = createRun(forge.db, { repoId: repo.id, kind: "deploy", env: "production" });
    claimRun(forge.db, run.id);
    return run.id;
  });
  expect(getRun(forge.db, h.runId)!.state).toBe("running");
  await h.press("x");
  await h.press("left");
  await h.press("enter");
  expect(state(h.runId)).toBe("cancelled");
  h.app.stop();
});

test("x does nothing on a finished run", async () => {
  const h = await open(alice, (repo) => {
    const run = createRun(forge.db, { repoId: repo.id, kind: "check" });
    claimRun(forge.db, run.id);
    finishRun(forge.db, run.id, { state: "ok", summary: "GREEN-MARK" });
    return run.id;
  });
  expect(h.hints()).not.toMatch(/x +cancel/);
  const text = await h.press("x");
  expect(text).not.toContain("Cancel run");
  expect(state(h.runId)).toBe("ok");
  h.app.stop();
});

test("a reader is not offered x and a press changes nothing", async () => {
  const h = await open(bob, queued());
  expect(h.hints()).not.toMatch(/x +cancel/);
  const text = await h.press("x");
  expect(text).not.toContain("Cancel run");
  expect(state(h.runId)).toBe("queued");
  h.app.stop();
});

test("a run that finished meanwhile answers in one line", async () => {
  const h = await open(alice, queued());
  await h.press("x");
  claimRun(forge.db, h.runId);
  finishRun(forge.db, h.runId, { state: "ok", summary: "done" });
  await h.press("left");
  const text = await h.press("enter");
  expect(text).toContain("already finished");
  expect(state(h.runId)).toBe("ok");
  h.app.stop();
});
