/** `enter` on a run opens its log in the terminal, as MCP `run_log` reads it (#7306). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendFileSync } from "node:fs";
import { announceRun } from "../src/actions/runs.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { appendRunLog, runLogPath } from "../src/runs/log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { runLogScreen } from "../src/tui/screens/runlog.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let repo: Repo;
let alice: User;
let bob: User;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-runlog-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await createUser(forge.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.test", password: "a-long-passphrase" });
  if (!b.ok) throw new Error("bob failed");
  bob = b.value;
  const r = await createRepo(forge, alice, { name: "lamp", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const open = async (user: User, runId: string) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(100, 20), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(runLogScreen(session, app.ctx, repo, runId));
  await settleApp(app);
  return app;
};

test("a finished run shows its state and its last 200 lines, at the end", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  for (let i = 1; i <= 300; i++) appendRunLog(dir, run.id, `line-${i}`);
  finishRun(forge.db, run.id, { state: "failed", summary: "BOOM-SUMMARY" });
  const app = await open(alice, run.id);
  const text = app.screen.toText();
  expect(text).toContain("failed");
  expect(text).toContain("BOOM-SUMMARY");
  expect(text).toContain("line-300");
  expect(text).not.toContain("\nline-2\n");
  app.dispatch({ type: "key", key: "g", ctrl: false, alt: false, shift: false });
  await settleApp(app);
  expect(app.screen.toText()).toContain("line-101");
  expect(app.screen.toText()).not.toContain("\nline-100\n");
});

test("a log the viewer may not read is not found and nothing of it is drawn", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  appendRunLog(dir, run.id, "SECRET-LINE");
  finishRun(forge.db, run.id, { state: "ok", summary: "SECRET-SUMMARY" });
  const app = await open(bob, run.id);
  const text = app.screen.toText();
  expect(text).toContain("Not found");
  expect(text).not.toContain("SECRET-LINE");
  expect(text).not.toContain("SECRET-SUMMARY");
});

const key = async (app: Awaited<ReturnType<typeof open>>, k: string) => {
  app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
  await settleApp(app);
};

test("a running run's new lines appear as they are written, with no reread", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  appendRunLog(dir, run.id, "first-line");
  const app = await open(alice, run.id);
  expect(app.screen.toText()).toContain("first-line");
  appendRunLog(dir, run.id, "later-line");
  await settleApp(app);
  expect(app.screen.toText()).toContain("later-line");
});

test("a viewer at the end follows new lines; one who scrolled up keeps their place", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  for (let i = 1; i <= 100; i++) appendRunLog(dir, run.id, `row-${i}`);
  const app = await open(alice, run.id);
  expect(app.screen.toText()).toContain("row-100");
  appendRunLog(dir, run.id, "row-101");
  await settleApp(app);
  expect(app.screen.toText()).toContain("row-101");
  await key(app, "g");
  expect(app.screen.toText()).toContain("\nrow-1\n");
  appendRunLog(dir, run.id, "row-102");
  await settleApp(app);
  expect(app.screen.toText()).toContain("\nrow-1\n");
  expect(app.screen.toText()).not.toContain("row-102");
  await key(app, "G");
  expect(app.screen.toText()).toContain("row-102");
});

test("the end of the run shows on the state line, and a finished run is not reread", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  appendRunLog(dir, run.id, "working");
  const app = await open(alice, run.id);
  expect(app.screen.toText()).toContain("running");
  const done = finishRun(forge.db, run.id, { state: "ok", summary: "ALL-DONE" });
  if (done === undefined) throw new Error("finish failed");
  announceRun(forge, done);
  await settleUntil(app, "ALL-DONE");
  expect(app.screen.toText()).not.toContain("live");
  // A reread would show a line written behind the listener's back. Another
  // run's event after the sneak is a signal that the bus has been drained.
  appendFileSync(runLogPath(dir, run.id), "SNEAKED\n");
  announceRun(forge, done);
  await new Promise<void>((resolve) => {
    const off = forge.bus.subscribe(() => {
      off();
      setTimeout(resolve, 80);
    });
    announceRun(forge, done);
  });
  await settleApp(app);
  expect(app.screen.toText()).not.toContain("SNEAKED");
});

test("another run's events do not reread this one", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  appendRunLog(dir, run.id, "mine");
  const other = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  const app = await open(alice, run.id);
  appendFileSync(runLogPath(dir, run.id), "SNEAKED\n");
  announceRun(forge, other);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await settleApp(app);
  expect(app.screen.toText()).not.toContain("SNEAKED");
});

test("r rereads the log, and o prints the web address", async () => {
  const run = createRun(forge.db, { repoId: repo.id, kind: "agent" });
  claimRun(forge.db, run.id);
  appendRunLog(dir, run.id, "before");
  const app = await open(alice, run.id);
  appendFileSync(runLogPath(dir, run.id), "BEHIND-THE-LISTENER\n");
  await key(app, "r");
  expect(app.screen.toText()).toContain("BEHIND-THE-LISTENER");
  await key(app, "o");
  expect(app.screen.toText()).toContain(`/alice/lamp/runs/${run.id}`);
});
