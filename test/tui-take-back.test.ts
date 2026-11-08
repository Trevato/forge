/**
 * The terminal's pull screen takes back a shipped pull with `T` and a
 * confirm, as the page does: absent on an open pull and to an agent, No
 * changes nothing, Yes opens the revert pull, and a second take-back or
 * one that conflicts is refused in the page's words.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { mergePull, openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { getPull, revertOf, type Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { pullScreen } from "../src/tui/screens/pull.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dataDir: string;
let app: App;
let alice: User;
let repo: Repo;
let n = 0;
const running: { stop(): void }[] = [];

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-take-back-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  alice = made.value;
  const r = await createRepo(app, alice, { name: "lib", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  await commitToBranch(app, alice, repo, {
    branch: "main",
    message: "base",
    files: [{ path: "code.txt", content: "alpha\n" }],
  });
});

afterEach(async () => {
  // Stop the screens before the database closes: a reload in flight would
  // otherwise land on a closed handle.
  for (const t of running.splice(0)) t.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const pullOf = async (merge: boolean): Promise<Pull> => {
  const branch = `b${++n}`;
  await commitToBranch(app, alice, repo, {
    branch,
    base: "main",
    message: branch,
    files: [{ path: "code.txt", content: `alpha\n${branch}\n` }],
  });
  const opened = await openPull(app, alice, repo, {
    title: `Change ${branch}`,
    baseBranch: "main",
    headBranch: branch,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  if (merge) {
    const m = await mergePull(app, alice, repo, opened.value, "squash");
    if (!m.ok) throw new Error(JSON.stringify(m.error));
  }
  return getPull(app.db, repo.id, opened.value.number)!;
};

async function open(
  number: number,
  user: User | null = alice,
  shown: Repo = repo,
) {
  const { app: tui, session } = createForgeApp(
    app,
    {
      sshUsername: user?.username ?? "guest",
      remoteAddress: "127.0.0.1",
      fingerprint: "SHA256:x",
      user: user ?? undefined,
    },
    { terminal: headlessTerminal(160, 44), exitHooks: false },
  );
  tui.start();
  running.push(tui);
  tui.ctx.push(pullScreen(session, tui.ctx, local(session, shown), number));
  await settleApp(tui);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys)
      tui.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(tui);
  };
  return { press, text: () => tui.screen.toText() };
}

test("the key is absent on an open pull", async () => {
  const pull = await pullOf(false);
  const t = await open(pull.number);
  expect(t.text()).not.toContain("take it back");
  await t.press("T");
  expect(t.text()).not.toContain("Take back");
  expect(revertOf(app.db, repo.id, pull.id)).toBeUndefined();
});

test("the key is absent to an agent", async () => {
  const pull = await pullOf(true);
  const made = await createAgent(app, alice, { username: "quill" });
  if (!made.ok) throw new Error(String(made.error));
  addToCrew(app, alice, repo, "quill");
  const t = await open(pull.number, getUserByName(app.db, "quill")!);
  expect(t.text()).not.toContain("take it back");
  await t.press("T");
  expect(t.text()).not.toContain("Take back");
});

test("T asks, Yes opens the new pull's screen", async () => {
  const pull = await pullOf(true);
  const t = await open(pull.number);
  expect(t.text()).toContain("take it back");
  await t.press("T");
  expect(t.text()).toContain(`Take back #${pull.number}`);
  expect(t.text()).toContain(pull.title);
  await t.press("right", "enter");
  const made = revertOf(app.db, repo.id, pull.id);
  expect(made).toBeDefined();
  expect(t.text()).toContain(`Revert "${pull.title}"`);
});

test("No makes nothing", async () => {
  const pull = await pullOf(true);
  const t = await open(pull.number);
  await t.press("T", "enter");
  expect(t.text()).not.toContain("Take back #");
  expect(revertOf(app.db, repo.id, pull.id)).toBeUndefined();
});

test("a second take-back is refused as already taken back", async () => {
  const pull = await pullOf(true);
  const first = await open(pull.number);
  await first.press("T", "right", "enter");
  expect(revertOf(app.db, repo.id, pull.id)).toBeDefined();
  const again = await open(pull.number);
  await again.press("T", "right", "enter");
  expect(again.text()).toContain("it has already been taken back");
});

test("a take-back that no longer applies is refused naming the file, and leaves nothing", async () => {
  const first = await pullOf(true);
  await pullOf(true);
  const t = await open(first.number);
  await t.press("T", "right", "enter");
  expect(t.text()).toContain(
    "That could not be taken back: it conflicts with the current code in code.txt.",
  );
  expect(revertOf(app.db, repo.id, first.id)).toBeUndefined();
});

test("a guest and a read-only user are shown no key and press it for nothing", async () => {
  const pull = await pullOf(true);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(String(made.error));
  for (const who of [null, made.value]) {
    const t = await open(pull.number, who);
    expect(t.text()).not.toContain("take it back");
    await t.press("T");
    expect(t.text()).not.toContain("Take back");
    expect(revertOf(app.db, repo.id, pull.id)).toBeUndefined();
  }
});

test("a mirrored repository shows no key", async () => {
  const pull = await pullOf(true);
  const mirror: Repo = {
    ...repo,
    origin: {
      originId: "o1",
      kind: "github",
      fullName: "up/lib",
      htmlUrl: "https://example.test/up/lib",
      lastFetchAt: null,
      fetchError: "",
    },
  };
  const t = await open(pull.number, alice, mirror);
  expect(t.text()).not.toContain("take it back");
  await t.press("T");
  expect(t.text()).not.toContain("Take back");
  expect(revertOf(app.db, repo.id, pull.id)).toBeUndefined();
});
