/** `m` on the issues list opens the plan: working, ready now, waiting, parked twice; Enter opens the issue. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { addComment, createIssue, type Issue } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { HOT_PULLS, rememberPullFiles } from "../src/crew/hot_files.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { issuesScreen } from "../src/tui/screens/issues.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let repo: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-plan-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, {
    username: "alice",
    email: "alice@forge.test",
    password: "a-long-passphrase",
  });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const r = await createRepo(forge, alice, { name: "plan", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const make = async (title: string): Promise<Issue> => {
  const r = await openIssue(forge, alice, repo, { title, body: "x" });
  if (!r.ok) throw new Error(`issue failed: ${r.error}`);
  return r.value;
};

const open = async (user: User, where: Repo = repo, kind: "issue" | "pull" = "issue") => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(issuesScreen(session, app.ctx, local(session, where), kind));
  await settleApp(app);
  const press = async (key: string): Promise<void> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, press, text: () => app.screen.toText() };
};

test("m shows the plan in four groups, Enter opens an issue, a sealed issue stays out of a reader's", async () => {
  const ready = await make("Ready thing");
  const waiting = await make("Waiting thing");
  const running = await make("Running thing");
  addDependency(forge.db, waiting, ready, alice.id);
  expect(
    claimRun(
      forge.db,
      createRun(forge.db, { repoId: repo.id, kind: "agent", issueId: running.id, actorId: alice.id, reason: "assigned" }).id,
    ),
  ).toBeDefined();
  const sealed = createIssue(forge.db, { repoId: repo.id, authorId: alice.id, title: "Secret report", sealed: true });
  if (!sealed.ok) throw new Error(String(sealed.error));

  const h = await open(alice);
  expect(h.text()).toContain("m  plan");
  await h.press("m");
  const t = h.text();
  expect(t).toContain("Working 1");
  expect(t).toContain("Ready now");
  expect(t).toContain("Waiting 1");
  expect(t).toContain("Parked twice 0");
  expect(t).toContain(`#${running.number} Running thing`);
  expect(t).toContain(`#${waiting.number} Waiting thing — waits on #${ready.number}`);
  expect(t).toContain(`#${ready.number} Ready thing`);

  // The cursor starts on the first issue row, not on the "Working" heading.
  await h.press("enter");
  expect(h.app.screen.toText()).toContain("Running thing");
  expect(h.app.screen.toText()).not.toContain("Ready now");
  h.app.stop();

  const carol = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username: "carol",
    email: "carol@forge.test",
    password: "a-good-passphrase",
  });
  if (!carol.ok) throw new Error(String(carol.error));
  const mine = await open(alice);
  await mine.press("m");
  expect(mine.text()).toContain("Secret report");
  mine.app.stop();
  const theirs = await open(carol.value);
  await theirs.press("m");
  expect(theirs.text()).toContain("Ready thing");
  expect(theirs.text()).not.toContain("Secret report");
  theirs.app.stop();
});

test("a parked-twice issue has its row with every reason; a held ready issue says what holds it; an empty plan shows four empty groups", async () => {
  const r = await createRepo(forge, alice, { name: "held", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  const where = r.value;
  const add = (title: string, body = ""): Issue => {
    const made = createIssue(forge.db, { repoId: where.id, authorId: alice.id, title, body });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };

  const empty = await open(alice, where);
  await empty.press("m");
  for (const heading of ["Working 0", "Ready now 0", "Waiting 0", "Parked twice 0"])
    expect(empty.text()).toContain(heading);
  expect(empty.text()).not.toContain("Reading…");
  empty.app.stop();

  const hot = add("Add a flag to src/hot.ts", "");
  const stuck = add("Stuck thing");
  for (const why of ["the tests would not build", "the diff kept conflicting"])
    addComment(forge.db, { issueId: stuck.id, authorId: alice.id, body: `Parked by the crew: ${why}.` });
  rememberPullFiles(
    where.id,
    Array.from({ length: HOT_PULLS }, (_, i) => ({ number: i + 1, files: ["src/hot.ts"] })),
  );
  try {
    const h = await open(alice, where);
    await h.press("m");
    const lines = h.text().split("\n");
    const row = (needle: string): string => lines.find((l) => l.includes(needle)) ?? "";
    expect(h.text()).toContain("Parked twice 1");
    expect(row(`#${stuck.number} Stuck thing`)).toContain("the tests would not build; the diff kept conflicting");
    expect(h.text()).toContain("Ready now 1");
    expect(row(`#${hot.number} Add a flag`)).toContain("src/hot.ts is in");
    // Enter on the first row lands on an issue, never on a heading.
    await h.press("enter");
    expect(h.text()).toContain("Add a flag to src/hot.ts");
    expect(h.text()).not.toContain("Parked twice");
    h.app.stop();
  } finally {
    rememberPullFiles(where.id, []);
  }
});

test("m is offered on the issues list and not on the pulls list", async () => {
  const issues = await open(alice, repo, "issue");
  expect(issues.text()).toContain("m  plan");
  issues.app.stop();
  const pulls = await open(alice, repo, "pull");
  expect(pulls.text()).not.toContain("m  plan");
  await pulls.press("m");
  expect(pulls.text()).not.toContain("Parked twice");
  pulls.app.stop();
});
