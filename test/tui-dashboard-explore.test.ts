/** The launcher's search line with `kind:` or `sort:` is the explorer's, ranked by the page's action (#7325). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { explorePage, parseExploreQuery } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { promote } from "./helpers/members.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;

const appOf = async (owner: User, name: string): Promise<Repo> => {
  const made = await createRepo(forge, owner, { name, visibility: "public", description: `the ${name} app` });
  if (!made.ok) throw new Error(String(made.error));
  const record = insertApp(forge.db, { repoId: made.value.id, slug: `${owner.username}-${name}`, access: "public" });
  if (!record.ok) throw new Error(record.error);
  return made.value;
};

const forkOf = async (parent: Repo, owner: User, name: string): Promise<void> => {
  const made = await createRepo(forge, owner, { name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  forge.db.query(`UPDATE repo SET fork_parent_id = ?1 WHERE id = ?2`).run(parent.id, made.value.id);
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-explore-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const make = async (username: string): Promise<User> => {
    const u = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@forge.test`, password: "a-long-passphrase" });
    if (!u.ok) throw new Error(u.error);
    proveAll(forge);
    promote(forge.db, u.value);
    return u.value;
  };
  alice = await make("alice");
  bob = await make("bob");
  const zed = await appOf(alice, "zed");
  const mid = await appOf(alice, "mid");
  await appOf(alice, "ant");
  await forkOf(zed, bob, "zed-one");
  await forkOf(zed, bob, "zed-two");
  await forkOf(mid, bob, "mid-one");
  const vault = await appOf(bob, "vault");
  forge.db.query(`UPDATE repo SET visibility = 'private' WHERE id = ?1`).run(vault.id);
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

async function typed(line: string, then: string[] = [], user: User | undefined = alice): Promise<string> {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: user?.username ?? "git", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const press = (key: string): void => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("/");
  for (const ch of line) press(ch);
  // The ranking is answered off the keystroke; wait for it before pressing on.
  await settleApp(app);
  for (const key of then) press(key);
  await settleApp(app);
  const text = app.screen.toText();
  app.stop();
  return text;
}

test("kind:app sort:forks lists the apps in the order the page's action gives, with their numbers", async () => {
  const page = await explorePage(forge, alice, parseExploreQuery("kind:app sort:forks"), null);
  const order = page!.items.map((r) => r.name);
  expect(order).toEqual(["alice/zed", "alice/mid", "alice/ant"]);
  const text = await typed("kind:app sort:forks");
  const at = (name: string): number => text.indexOf(name);
  for (const name of order) expect(at(name)).toBeGreaterThan(-1);
  const positions = order.map(at);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(text).toContain("2 forks");
  expect(text).toContain("1 fork");
  expect(text).toContain("Read as: kind:app sort:forks");
});

test("an unknown word is said back as the text the query understood", async () => {
  const text = await typed("kind:app sort:nonsense");
  expect(text).toContain("Read as: kind:app sort:nonsense");
  expect(text).toContain("Nothing matches kind:app sort:nonsense");
});

test("a plain search still matches repositories by name, with no explorer line", async () => {
  const text = await typed("zed-one");
  expect(text).toContain("bob/zed-one");
  expect(text).not.toContain("alice/ant");
  expect(text).not.toContain("Read as:");
});

test("enter on a person row says it has no terminal page", async () => {
  const text = await typed("kind:person", ["enter", "enter"]);
  expect(text).toContain("no terminal page");
  expect(text).toContain("Read as: kind:person");
});

test("enter on an app row opens it", async () => {
  const text = await typed("kind:app sort:forks", ["enter", "enter"]);
  expect(text).toContain("alice › alice/zed");
  expect(text).not.toContain("Read as:");
});

test("a guest's explorer rows hold no private repository; its owner's do", async () => {
  expect(await typed("kind:app", [], bob)).toContain("bob/vault");
  expect(await typed("kind:app", [], alice)).not.toContain("bob/vault");
  const guest = await typed("kind:app", [], undefined);
  expect(guest).toContain("alice/zed");
  expect(guest).not.toContain("bob/vault");
});

test("pin, mark and archive on an explorer row say they do not apply", async () => {
  const text = await typed("kind:app sort:forks", ["enter", "p"]);
  expect(text).toContain("act on your repositories");
});

test("while a new line is ranked, the old rows are not shown under it", async () => {
  const terminal = headlessTerminal(200, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user: alice },
    { terminal, exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const press = (key: string): void => app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
  press("/");
  for (const ch of "kind:app") press(ch);
  await settleApp(app);
  press(" ");
  for (const ch of "sort:forks") press(ch);
  app.frame();
  const text = app.screen.toText();
  app.stop();
  expect(text).not.toContain("alice/zed");
});
