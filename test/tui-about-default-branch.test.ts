/**
 * The default branch at the terminal's door (#8067): on the About card an
 * admin presses `b`, picks one of the repository's branches, and `y` moves
 * git HEAD and the card's row through `updateRepoSettings`. `n` and esc change
 * nothing; a branch that vanished is a toast; a non-admin is not offered it.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBranch, deleteBranch } from "../src/actions/branches.ts";
import { createAgent } from "../src/actions/crew.ts";
import { commitToBranch } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo, getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { headBranch } from "../src/git/read.ts";
import { repoDir } from "../src/git/repos.ts";
import type { Ctx, Screen } from "../src/tui/app/app.ts";
import { aboutScreen } from "../src/tui/screens/about.ts";
import { Screen as Surface } from "../src/tui/term/screen.ts";
import { theme } from "../src/tui/ui/theme.ts";
import { localSource } from "../src/view/local.ts";
import type { Session } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let founder: User;
let writer: User;
let bot: User;
let botRepo: Repo;
let repo: Repo;

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
async function until(what: string, done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
const head = async () => {
  const h = await headBranch(repoDir(app.reposRoot, repo.ownerName, repo.name));
  return h.ok ? h.value : "";
};

function card(user: User, target: Repo = repo) {
  const pushed: Screen[] = [];
  const toasts: string[] = [];
  const ctx = {
    theme: theme("dark"),
    invalidate() {},
    toast: (t: string) => toasts.push(t),
    push: (s: Screen) => pushed.push(s),
    pop() {},
    copy() {},
    hit() {},
    setCursor() {},
  } as unknown as Ctx;
  const f = { app, db: app.db, user } as unknown as Session;
  const src = localSource(app, getRepoById(app.db, target.id)!, user);
  const screen = aboutScreen(f, ctx, { render() {} } as unknown as Screen, src, undefined, "main");
  const label = (key: string) => screen.keys.find((b) => b.keys.includes(key))?.help;
  const press = (key: string) => screen.key!({ key } as never);
  const text = () => {
    const s = new Surface(120, 40);
    screen.render({ x: 0, y: 0, w: 120, h: 40 }, s);
    return s.toText();
  };
  return { pushed, toasts, label, press, text };
}
const key = (s: Screen, k: string) => s.key!({ key: k } as never);

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-tui-default-branch-"));
  app = createApp({ dataDir, port: 0 });
  const make = async (username: string, adminIfFirst = false) =>
    ok(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      }),
    );
  const root = await make("founding", true);
  founder = await make("founder");
  writer = await make("writer");
  const org = ok(createOrg(app.db, "acme", founder.id));
  repo = ok(await createRepo(app.db, app.reposRoot, { ownerId: org.id, name: "site", visibility: "public" }));
  addTeamMember(app.db, ok(createTeam(app.db, org.id, "Writers", "write")), writer.id);
  ok(await commitToBranch(app, founder, repo, { message: "seed", files: [{ path: "a.txt", content: "a\n" }] }));
  ok(await createBranch(app, founder, repo, { name: "trunk" }));
  ok(await createBranch(app, founder, repo, { name: "gone" }));
  bot = ok(await createAgent(app, root, { username: "bot" })).user;
  botRepo = ok(await createRepo(app.db, app.reposRoot, { ownerId: bot.id, name: "own", visibility: "public" }));
}, 30_000);

afterAll(async () => {
  app?.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** Press `b`, wait for the picker, move to `branch`, enter; returns the confirm. */
async function choose(c: ReturnType<typeof card>, branch: string): Promise<Screen> {
  c.press("b");
  await until("the picker", () => c.pushed.length === 1);
  const picker = c.pushed[0]!;
  const s = new Surface(100, 30);
  picker.render({ x: 0, y: 0, w: 100, h: 30 }, s);
  const lines = s.toText().split("\n");
  expect(lines.find((l) => l.includes("main"))).toContain("default");
  // Branches are sorted: gone, main, trunk.
  const order = ["gone", "main", "trunk"];
  for (let i = 0; i < order.indexOf(branch); i++) key(picker, "j");
  key(picker, "enter");
  await until("the confirm", () => c.pushed.length === 2);
  return c.pushed[1]!;
}

test("n and esc change nothing", async () => {
  const c = card(founder);
  const confirm = await choose(c, "trunk");
  const s = new Surface(100, 30);
  confirm.render({ x: 0, y: 0, w: 100, h: 30 }, s);
  expect(s.toText()).toContain("make trunk the default? y/n");
  key(confirm, "n");
  await Bun.sleep(30);
  expect(await head()).toBe("main");
  expect(getRepoById(app.db, repo.id)!.defaultBranch).toBe("main");
  expect(c.text()).toContain("main");
  // esc on the picker, too.
  const d = card(founder);
  d.press("b");
  await until("the picker", () => d.pushed.length === 1);
  key(d.pushed[0]!, "esc");
  await Bun.sleep(30);
  expect(d.pushed).toHaveLength(1);
  expect(await head()).toBe("main");
});

test("a branch that vanished is a toast and the card is unchanged", async () => {
  const c = card(founder);
  const confirm = await choose(c, "gone");
  ok(await deleteBranch(app, founder, getRepoById(app.db, repo.id)!, "gone"));
  key(confirm, "y");
  await until("the toast", () => c.toasts.length > 0);
  expect(c.toasts[0]).toContain("no longer a branch");
  expect(await head()).toBe("main");
  expect(getRepoById(app.db, repo.id)!.defaultBranch).toBe("main");
});

test("an admin chooses trunk and y moves HEAD and the row", async () => {
  const c = card(founder);
  expect(c.label("b")).toBe("default branch");
  const confirm = await choose(c, "trunk");
  key(confirm, "y");

  await until("the setting", () => getRepoById(app.db, repo.id)!.defaultBranch === "trunk");
  expect(await head()).toBe("trunk");
  await until("the toast", () => c.toasts.length > 0);
  expect(c.toasts).toEqual(["trunk is the default branch"]);
  expect(c.text()).toMatch(/default branch\s+trunk/);
  // The picker marks the new default, not the old one.
  const again = card(founder);
  again.press("b");
  await until("the picker", () => again.pushed.length === 1);
  const s = new Surface(100, 30);
  again.pushed[0]!.render({ x: 0, y: 0, w: 100, h: 30 }, s);
  const lines = s.toText().split("\n");
  expect(lines.find((l) => l.includes("trunk"))).toContain("default");
  expect(lines.find((l) => l.includes("main"))).not.toContain("default");
});

test("a non-admin and an agent admin are not offered b, and pressing it does nothing", async () => {
  for (const [who, at] of [[writer, repo], [bot, botRepo]] as const) {
    const c = card(who, at);
    expect(c.label("b")).toBeUndefined();
    c.press("b");
    await Bun.sleep(30);
    expect(c.pushed).toHaveLength(0);
  }
});
