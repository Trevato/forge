/** Curated packs in the terminal (#11006): the same gate and the same door as the page. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getPack } from "../src/packs/curated.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { curatedScreen, packsScreen } from "../src/tui/screens/packs.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { adminCookie } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";

let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let bob: User;
let adminHeader: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-packs-tui-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  adminHeader = await adminCookie(app, { username: "trevato", email: "t@forge.local", password: "a-good-passphrase" });
  admin = getUserByName(app.db, "trevato")!;
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  bob = made.value;
  createSession(app.db, bob.id);
  for (const [name, visibility] of [["chess", "public"], ["pong", "public"], ["secret-one", "private"]] as const) {
    const r = await createRepo(app.db, app.reposRoot, { ownerId: admin.id, name, visibility, description: `${name} game`, defaultBranch: "main" });
    if (!r.ok) throw new Error(r.error);
  }
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });
function open(user: User, make: (session: never, ctx: never) => ReturnType<typeof curatedScreen>) {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  tui.start();
  const screen = make(session as never, tui.ctx as never);
  tui.ctx.push(screen);
  return { tui, screen };
}
const web = async (path: string, cookie = "") => await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("browse: a guest sees the public repos and never a private or missing name; an admin sees why they are left out", async () => {
  const set = (repos: string[]) => app.db.transaction(() => {
    app.db.query("DELETE FROM curated_pack_repo WHERE pack = 'gamer'").run();
    repos.forEach((r, i) => app.db.query("INSERT INTO curated_pack_repo (pack, repo, position) VALUES ('gamer', ?1, ?2)").run(r, i));
  })();
  set(["trevato/chess", "trevato/secret-one", "trevato/nowhere"]);
  const guest = open(bob, (s, c) => curatedScreen(s, c, "gamer"));
  await settleApp(guest.tui);
  const seen = guest.tui.screen.toText();
  expect(seen).toContain("trevato/chess");
  expect(seen).not.toContain("secret-one");
  expect(seen).not.toContain("nowhere");
  expect(seen).not.toContain("History");
  expect(guest.screen.key(key("x"))).toBe(false); // a guest has no edit keys
  expect(await web("/packs/gamer")).not.toContain("secret-one");
  const boss = open(admin, (s, c) => curatedScreen(s, c, "gamer"));
  await settleApp(boss.tui);
  expect(boss.tui.screen.toText()).toContain("trevato/secret-one  (not public)");
  expect(boss.tui.screen.toText()).toContain("trevato/nowhere  (not on this forge)");
  guest.tui.stop?.();
  boss.tui.stop?.();
});

test("edit: an admin's keys add, move and remove a repo, and the page shows it at once; a guest's do nothing", async () => {
  const boss = open(admin, (s, c) => curatedScreen(s, c, "business"));
  await settleApp(boss.tui);
  const before = getPack(app.db, "business")!.repos;
  boss.screen.key(key("x")); // the cursor starts on the first repo
  expect(getPack(app.db, "business")!.repos).toEqual(before.slice(1));
  boss.screen.key(key("d"));
  const moved = getPack(app.db, "business")!.repos;
  expect(moved.slice(0, 2)).toEqual([before[2]!, before[1]!]);
  expect(await web("/packs/business", adminHeader)).toContain(`trevato removed ${before[0]!}`);
  const guest = open(bob, (s, c) => curatedScreen(s, c, "business"));
  for (const k of ["x", "u", "d", "a", "t"]) guest.screen.key(key(k));
  expect(getPack(app.db, "business")!.repos).toEqual(moved);
  boss.screen.key(key("a"));
  await settleApp(boss.tui);
  expect(boss.tui.screen.toText()).toContain("Add a repo");
  boss.tui.stop?.();
  guest.tui.stop?.();
});

test("start: s opens the new-forge form with the pack's shown repos and brief, and only those", async () => {
  const guest = open(bob, (s, c) => curatedScreen(s, c, "gamer"));
  guest.screen.key(key("s"));
  await settleApp(guest.tui);
  const text = guest.tui.screen.toText();
  expect(text).toContain("trevato/chess");
  expect(text).not.toContain("secret-one");
  expect(text).toContain("how it plays now");
  guest.tui.stop?.();
});

test("the list shows the curated packs, and n makes one for an admin only", async () => {
  const boss = open(admin, (s, c) => packsScreen(c as never, undefined, (s as { app: App }).app, s as never) as never);
  await settleApp(boss.tui);
  expect(boss.tui.screen.toText()).toContain("Gamer");
  expect(boss.screen.key(key("n"))).toBe(true);
  await settleApp(boss.tui);
  expect(boss.tui.screen.toText()).toContain("New pack");
  const guest = open(bob, (s, c) => packsScreen(c as never, undefined, (s as { app: App }).app, s as never) as never);
  expect(guest.screen.key(key("n"))).toBe(false);
  boss.tui.stop?.();
  guest.tui.stop?.();
});
