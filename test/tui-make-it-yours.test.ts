/** The terminal's repository screen makes an app yours with `Y`: plan, confirm, copy (#7270). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newApp } from "../src/actions/apps.ts";
import { COPIES_PER_DAY, makeItYours } from "../src/actions/make_it_yours.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { repoScreen } from "../src/tui/screens/repo.ts";
import { local } from "../src/tui/screens/where.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let carol: User;
let n = 0;

const mkUser = async (username: string, first = false): Promise<User> => {
  const r = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.test`,
    password: "a-long-passphrase",
    adminIfFirst: first,
  });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const original = async (name = `orchard${n++}`): Promise<Repo> => {
  const made = await newApp(forge, alice, { name, visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  return made.value.repo;
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-yours-"));
  forge = createApp({ dataDir: dir, port: 0 });
  alice = await mkUser("alice", true);
  bob = await mkUser("bob");
  carol = await mkUser("carol");
  promote(forge.db);
  proveAll(forge);
}, 60_000);
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

async function open(user: User | undefined, repo: Repo) {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: user?.username ?? "anon", remoteAddress: "127.0.0.1", user },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(repoScreen(session, app.ctx, local(session, repo)));
  await settleApp(app);
  const press = async (key: string): Promise<string> => {
    app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
    return app.screen.toText();
  };
  return { app, press };
}

test("Y plans first: what is copied and what is not, and nothing is made", async () => {
  const repo = await original();
  const h = await open(bob, repo);
  const text0 = await h.press("Y");
  expect(text0).toContain("Make it yours");
  const text = await h.press("enter");
  expect(text).toContain(`alice/${repo.name} -> bob/${repo.name} (private)`);
  expect(text).toContain("the code, its history");
  expect(text).toContain("the app's data");
  expect(text).toContain("follows the original");
  expect(getRepo(forge.db, "bob", repo.name)).toBeUndefined();
  h.app.stop();
});

test("a confirm copies, and the copy opens", async () => {
  const repo = await original();
  const h = await open(bob, repo);
  await h.press("Y");
  await h.press("enter");
  const text = await h.press("enter");
  expect(getRepo(forge.db, "bob", repo.name)).toBeDefined();
  expect(text).not.toContain("Make it yours");
  expect(text).toContain(`› bob/${repo.name}`);
  h.app.stop();
});

test("esc copies nothing", async () => {
  const repo = await original();
  const h = await open(bob, repo);
  await h.press("Y");
  await h.press("enter");
  await h.press("esc"); // the confirm
  await h.press("esc"); // the screen
  expect(getRepo(forge.db, "bob", repo.name)).toBeUndefined();
  h.app.stop();
});

test("a sixth copy in a day is refused in MCP's words, and nothing is made", async () => {
    for (let i = 0; i < COPIES_PER_DAY; i++) {
    const r = await makeItYours(forge, carol, await original(), { dryRun: false });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  }
  const repo = await original();
  const h = await open(carol, repo);
  await h.press("Y");
  await h.press("enter");
  const text = await h.press("enter");
  expect(text).toContain(`at most ${COPIES_PER_DAY} copies a day; another after `);
  expect(getRepo(forge.db, "carol", repo.name)).toBeUndefined();
  h.app.stop();
});

test("your own repository is refused as 'already yours'", async () => {
  const repo = await original();
  const h = await open(alice, repo);
  await h.press("Y");
  const text = await h.press("enter");
  expect(text).toContain("this app is already yours");
  h.app.stop();
});

test("tab makes the copy public, and the plan says so", async () => {
  const repo = await original();
  const h = await open(bob, repo);
  await h.press("Y");
  await h.press("tab");
  const text = await h.press("enter");
  expect(text).toContain(`alice/${repo.name} -> bob/${repo.name} (public)`);
  h.app.stop();
});

test("a private original is never copied public: refused in the action's words", async () => {
  const made = await newApp(forge, bob, { name: "secret-plot", visibility: "private" });
  if (!made.ok) throw new Error(String(made.error));
  const h = await open(alice, made.value.repo); // a forge admin may read it
  await h.press("Y");
  await h.press("tab");
  await h.press("enter");
  // The refusal is the action's; under a loaded shard it may land a turn after the key settles.
  await settleUntil(h.app, "a copy of a private repository stays private");
  const text = h.app.screen.toText();
  expect(text).toContain("a copy of a private repository stays private");
  expect(getRepo(forge.db, "alice", "secret-plot")).toBeUndefined();
  h.app.stop();
});

test("a copy you already have is opened, not made twice", async () => {
  const repo = await original();
  const first = await makeItYours(forge, bob, repo, { dryRun: false });
  if (!first.ok) throw new Error(JSON.stringify(first.error));
  const h = await open(bob, repo);
  await h.press("Y");
  const plan = await h.press("enter");
  expect(plan).toContain(`You already have bob/${repo.name}: it opens.`);
  const text = await h.press("enter");
  expect(text).toContain(`› bob/${repo.name}`);
  const copies = forge.db
    .query<{ n: number }, [string, string]>("SELECT count(*) AS n FROM repo WHERE owner_id = ?1 AND fork_parent_id = ?2")
    .get(bob.id, repo.id)!.n;
  expect(copies).toBe(1);
  h.app.stop();
});

test("Y does nothing when not signed in", async () => {
  const repo = await original();
  const h = await open(undefined, repo);
  const text = await h.press("Y");
  expect(text).not.toContain("Make alice/");
  h.app.stop();
});
