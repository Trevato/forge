/**
 * The feed in the terminal: `r` on a post about an issue replies through the
 * same comment action as the page's Reply; a person who cannot read the
 * repository has no such post and no way to reply.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { readFeed } from "../src/feed/feed.ts";
import { replyTarget } from "../src/feed/reply.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { listComments } from "../src/core/issues.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir = "";
let forge: App;
let issueId = "";
let pullId = "";
let pullNumber = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-feed-reply-"));
  forge = createApp({ dataDir: dir, port: 0 });
  for (const [username, first] of [["root", true], ["alice", false], ["bob", false]] as const) {
    const made = await createUser(forge.db, {
      origin: "seed", trusted: true, allowReserved: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: first,
    });
    if (!made.ok) throw new Error(made.error);
    promote(forge.db, made.value);
  }
  const alice = getUserByName(forge.db, "alice")!;
  const repo = await createRepo(forge, alice, { name: "secret", visibility: "private" });
  if (!repo.ok) throw new Error(String(repo.error));
  await commitToBranch(forge, alice, repo.value, { message: "seed", files: [{ path: "README.md", content: "# s\n" }] });
  const issue = openIssue(forge, alice, repo.value, { title: "Hidden question", body: "why?" });
  if (!issue.ok) throw new Error(String(issue.error));
  issueId = issue.value.id;
  const open = await createRepo(forge, alice, { name: "open", visibility: "public" });
  if (!open.ok) throw new Error(String(open.error));
  await commitToBranch(forge, alice, open.value, { message: "seed", files: [{ path: "README.md", content: "# o\n" }] });
  await commitToBranch(forge, alice, open.value, {
    branch: "idea", base: "main", message: "an idea", files: [{ path: "idea.md", content: "idea\n" }],
  });
  const pull = await openPull(forge, alice, open.value, { title: "An idea", body: "", baseBranch: "main", headBranch: "idea" });
  if (!pull.ok) throw new Error(String(pull.error));
  pullId = pull.value.id;
  pullNumber = pull.value.number;
});

/** Moves the cursor onto the post linking to `link` in this person's feed. */
const downTo = (username: string, link: string): string[] => {
  const items = readFeed(forge.db, getUserByName(forge.db, username)!, { limit: 20 }).items;
  const at = items.findIndex((i) => i.link === link);
  if (at < 0) throw new Error(`no post for ${link}`);
  return Array.from({ length: at }, () => "j");
};

afterAll(async () => {
  forge.db.close();
  await rm(dir, { recursive: true, force: true });
});

function boot(username: string) {
  const terminal = headlessTerminal(140, 32);
  const identity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, username)! };
  const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
  app.start();
  const press = async (...keys: string[]) => {
    for (const k of keys) app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  const open = async () => {
    app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(app);
    await press(..."Feed", "enter");
  };
  const submit = async () => {
    app.dispatch({ type: "key", key: "d", ctrl: true, alt: false, shift: false });
    await settleApp(app);
  };
  return { text: () => app.screen.toText(), press, open, submit, stop: () => app.stop() };
}

test("r on a post about an issue posts a comment on it", async () => {
  const t = boot("alice");
  await t.open();
  expect(t.text()).toContain("Hidden question");
  await t.press("r");
  await t.press(..."Taking it.");
  await t.submit();
  expect(listComments(forge.db, issueId).map((c) => c.body)).toContain("Taking it.");
  t.stop();
});

test("r on a post about a pull posts a comment on it", async () => {
  const t = boot("alice");
  await t.open();
  await t.press(...downTo("alice", `/alice/open/pulls/${pullNumber}`));
  await t.press("r");
  expect(t.text()).toContain(`Reply on alice/open #${pullNumber}`);
  await t.press(..."Merging soon.");
  await t.submit();
  expect(listComments(forge.db, pullId).map((c) => c.body)).toContain("Merging soon.");
  t.stop();
});

test("an empty reply says so and posts nothing", async () => {
  const before = listComments(forge.db, pullId).length;
  const t = boot("alice");
  await t.open();
  await t.press(...downTo("alice", `/alice/open/pulls/${pullNumber}`));
  await t.press("r");
  await t.submit();
  expect(t.text()).toContain("write something first");
  expect(listComments(forge.db, pullId)).toHaveLength(before);
  t.stop();
});

test("a post about a thread the person cannot read has no reply target, even when present", () => {
  const db = forge.db;
  const post = { app: "alice/secret", link: "/alice/secret/issues/1" };
  expect(replyTarget(db, getUserByName(db, "bob")!, post)).toBeUndefined();
  expect(replyTarget(db, undefined, post)).toBeUndefined();
  expect(replyTarget(db, getUserByName(db, "alice")!, post)?.thread.number).toBe(1);
  // A link into another repository than the post's own is no target either.
  expect(replyTarget(db, getUserByName(db, "bob")!, { app: "alice/open", link: "/alice/secret/issues/1" })).toBeUndefined();
});

test("a person who cannot read the repository is not shown its post", async () => {
  const t = boot("bob");
  await t.open();
  expect(t.text()).not.toContain("Hidden question");
  await t.press("r");
  await t.press(..."Let me in.");
  await t.submit();
  expect(listComments(forge.db, issueId).map((c) => c.body)).not.toContain("Let me in.");
  t.stop();
});

test("l likes the post under the cursor, a second l takes it back, and the page's feed sees it", async () => {
  const alice = getUserByName(forge.db, "alice")!;
  const t = boot("alice");
  await t.open();
  await t.press("l");
  expect(t.text()).toContain("♥ 1");
  const [top] = readFeed(forge.db, alice, { limit: 1 }).items;
  expect(top!.likes).toBe(1);
  expect(top!.liked).toBe(true);
  // Another viewer's feed counts it live: the same table the page reads.
  await t.press("l");
  expect(t.text()).not.toContain("♥");
  expect(readFeed(forge.db, alice, { limit: 1 }).items[0]!.likes).toBeUndefined();
  t.stop();
});

test("l on a post the person cannot read likes nothing", async () => {
  const t = boot("bob");
  await t.open();
  await t.press("l");
  const secret = forge.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name = 'secret'").get()!.id;
  expect(forge.db.query("SELECT 1 FROM feed_like WHERE repo_id = ?1").get(secret)).toBeNull();
  t.stop();
});
