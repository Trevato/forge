/**
 * The terminal's Build an app screen (#11010): one prompt, the versions, a
 * version's files, Restore and Publish, through the calls the page uses, so
 * what is done here is what the page reads next.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionsIn } from "../src/actions/build_pull.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { buildsOf, chatBuildOf } from "../src/core/chat_build.ts";
import { getRepo, getRepoById } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { readerFor } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

let dir: string;
let app: App;
let alice: User;
const open = [":", "Build an app", "\r"];

async function drive(user: User, keys: string[]): Promise<string> {
  const terminal = headlessTerminal(120, 30);
  const { app: tui } = createForgeApp(app, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user }, { terminal, exitHooks: false });
  tui.start();
  await settleApp(tui);
  for (const k of keys) {
    terminal.feed(k);
    if (k === "\x1b") await Bun.sleep(150);
    await settleApp(tui);
    await Bun.sleep(30);
  }
  const text = tui.screen.toText();
  tui.stop?.();
  return text;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-build-"));
  app = createApp({ dataDir: dir, port: 0 });
  const r = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!r.ok) throw new Error(r.error);
  alice = r.value;
  proveAll(app);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

test("n starts a build, Enter opens it, Enter shows a version's files, R restores it and P publishes", async () => {
  const listed = await drive(alice, [...open, "n", "a recipe box", "\r"]);
  const [mine] = buildsOf(app.db, alice.id);
  expect(mine?.title).toBe("a recipe box");
  expect(listed).toContain("alice/recipe-box");

  const build = chatBuildOf(app.db, mine!.conversationId)!;
  const repo = getRepoById(app.db, build.repoId)!;
  const made = await commitToBranch(app, alice, repo, { branch: build.branch, message: "Add recipes", files: [{ path: "page.txt", content: "one\n" }] } as never);
  if (!made.ok) throw new Error(JSON.stringify(made.error));

  const versions = await drive(alice, [...open, "\r"]);
  expect(versions).toContain("v1  Add recipes");
  expect(versions).toContain("alice/recipe-box");
  expect(await drive(alice, [...open, "\r", "\r"])).toContain("page.txt");

  // Restore makes a new version from the chosen one; the branch keeps both.
  await drive(alice, [...open, "\r", "R", "\r"]);
  expect((await versionsIn(app, repo, build)).map((v) => v.subject)).toEqual(["Add recipes", "Restore v1"]);

  // Publish merges to main, where the page reads it.
  await drive(alice, [...open, "\r", "P", "\r"]);
  expect(chatBuildOf(app.db, mine!.conversationId)?.publishedAt).not.toBeNull();
  const main = await readerFor(repoDir(app.reposRoot, "alice", getRepo(app.db, "alice", "recipe-box")!.name)).object("refs/heads/main:page.txt");
  expect(main.ok && new TextDecoder().decode(main.value.body)).toBe("one\n");
});
