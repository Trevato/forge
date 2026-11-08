/** The terminal's runs list queues a failed or cancelled agent run again with `a` and a confirm (#7294). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { setIssueState } from "../src/core/issues.ts";
import { cancelRun, claimRun, createRun, finishRun, listRuns } from "../src/core/runs.ts";
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
let helper: User;
let n = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-run-requeue-"));
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
  const agent = await createAgent(forge, alice, { username: "helper" });
  if (!agent.ok) throw new Error(String(agent.error));
  helper = agent.value.user;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

/** A public repository with the helper on its crew and one finished agent run on an open issue. */
async function open(user: User, end: "failed" | "ok" | "cancelled" = "failed") {
  const r = await createRepo(forge, alice, { name: `lamp${n++}`, visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const repo = r.value;
  const crewed = addToCrew(forge, alice, repo, "helper");
  if (!crewed.ok) throw new Error(crewed.error);
  const issue = openIssue(forge, alice, repo, { title: "fix the lamp", body: "" });
  if (!issue.ok) throw new Error(String(issue.error));
  const run = createRun(forge.db, {
    repoId: repo.id,
    kind: "agent",
    issueId: issue.value.id,
    actorId: helper.id,
    reason: "assigned",
  });
  claimRun(forge.db, run.id);
  if (end === "cancelled") cancelRun(forge.db, run.id);
  else finishRun(forge.db, run.id, { state: end, summary: "flake" });
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(runsScreen(session, app.ctx, repo));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  const hints = () => app.screen.toText();
  const runs = () => listRuns(forge.db, repo.id, { limit: 50 });
  return { app, press, hints, runs, repo, issueId: issue.value.id };
}

test("a asks, yes queues the task again and the list shows the queued run", async () => {
  const h = await open(alice);
  expect(h.hints()).toMatch(/a +run again/);
  let text = await h.press("a");
  expect(text).toContain("Run again");
  expect(text).toContain("again?");
  expect(h.runs()).toHaveLength(1);
  await h.press("left"); // Keep -> Run again
  text = await h.press("enter");
  const after = h.runs();
  expect(after).toHaveLength(2);
  expect(after.map((r) => r.state).sort()).toEqual(["failed", "queued"]);
  expect(text).toContain("queued");
  expect(text).toContain("Queued");
  h.app.stop();
});

test("a cancelled agent run offers a too", async () => {
  const h = await open(alice, "cancelled");
  expect(h.hints()).toMatch(/a +run again/);
  h.app.stop();
});

test("esc and Keep change nothing", async () => {
  const h = await open(alice);
  await h.press("a");
  await h.press("esc");
  expect(h.runs()).toHaveLength(1);
  await h.press("a");
  await h.press("enter"); // defaults to Keep
  expect(h.runs()).toHaveLength(1);
  h.app.stop();
});

test("a succeeded run offers no a and a press changes nothing", async () => {
  const h = await open(alice, "ok");
  expect(h.hints()).not.toMatch(/a +run again/);
  const text = await h.press("a");
  expect(text).not.toContain("Run again");
  expect(h.runs()).toHaveLength(1);
  h.app.stop();
});

test("a reader is not offered a and a press changes nothing", async () => {
  const h = await open(bob);
  expect(h.hints()).not.toMatch(/a +run again/);
  const text = await h.press("a");
  expect(text).not.toContain("Run again");
  expect(h.runs()).toHaveLength(1);
  h.app.stop();
});

test("a closed issue is not offered a", async () => {
  const h = await open(alice);
  setIssueState(forge.db, h.issueId, "closed");
  await h.press("r");
  expect(h.hints()).not.toMatch(/a +run again/);
  h.app.stop();
});

test("a refusal after the confirm shows the action's words", async () => {
  const h = await open(alice);
  await h.press("a");
  setIssueState(forge.db, h.issueId, "closed");
  await h.press("left");
  const text = await h.press("enter");
  expect(text).toContain("its issue is closed or its agent is gone");
  expect(h.runs()).toHaveLength(1);
  h.app.stop();
});
