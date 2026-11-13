/**
 * Outside agents in the terminal (#12012): the settings page's block, from the
 * same actions and the same gate (a repository's admins). A write made here
 * reaches the bus, which is what redraws an open settings page.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintContributeToken } from "../src/actions/contribute_token.ts";
import { createApp, type App } from "../src/app.ts";
import { contributeOpen, listContribute } from "../src/core/contribute_token.ts";
import { createRepo, type Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { outsideAgentsCommands, outsideAgentsScreen } from "../src/tui/screens/outsideagents.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { adminCookie } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";

let dir: string;
let app: App;
let servers: Servers;
let admin: User;
let bob: User;
let repo: Repo;
let adminHeader: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-outside-tui-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  adminHeader = await adminCookie(app, { username: "trevato", email: "t@forge.local", password: "a-good-passphrase" });
  admin = getUserByName(app.db, "trevato")!;
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!made.ok) throw new Error(made.error);
  bob = made.value;
  createSession(app.db, bob.id);
  const r = await createRepo(app.db, app.reposRoot, { ownerId: admin.id, name: "lib", visibility: "public", description: "", defaultBranch: "main" });
  if (!r.ok) throw new Error(r.error);
  repo = r.value;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const key = (k: string) => ({ type: "key" as const, key: k, ctrl: false, alt: false, shift: false });
function open(user: User) {
  const { app: tui, session } = createForgeApp(
    app,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
    { terminal: headlessTerminal(120, 40), exitHooks: false },
  );
  tui.start();
  tui.ctx.push(outsideAgentsScreen(session, tui.ctx, repo));
  return { tui, session };
}
const web = async (path: string, cookie: string) => await (await fetch(`${servers.url}${path}`, { headers: { cookie } })).text();

test("an admin allows, sees a token, and revokes it, and each write is an event the page follows", async () => {
  const events: string[] = [];
  const off = app.bus.subscribe((e) => {
    if (e.repoId === repo.id) events.push(e.kind);
  });
  const { tui, session } = open(admin);
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Outside agents may not ask for a token");
  expect(await web("/trevato/lib/settings", adminHeader)).toContain("Allow");

  tui.dispatch(key("a"));
  await settleApp(tui);
  expect(contributeOpen(app.db, repo.id)).toBe(true);
  expect(events).toContain("contribute.open");
  expect(await web("/trevato/lib/settings", adminHeader)).toContain("Stop allowing");

  const made = await mintContributeToken(app, { agent: "codex", origin: "codex cloud", repo: "trevato/lib" }, "203.0.113.5", "https://forge.test");
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  tui.ctx.invalidate();
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("codex");
  expect(tui.screen.toText()).toContain("claimed, not verified");

  // Revoke asks first: cancelling keeps the token, confirming ends it.
  tui.dispatch(key("x"));
  await settleApp(tui);
  expect(tui.screen.toText()).toContain("Revoke token");
  tui.dispatch(key("esc"));
  await settleApp(tui);
  expect(listContribute(app.db, repo.id, new Date()).length).toBe(1);
  tui.dispatch(key("x"));
  await settleApp(tui);
  tui.dispatch(key("right"));
  tui.dispatch(key("enter"));
  await settleApp(tui);
  expect(listContribute(app.db, repo.id, new Date()).length).toBe(0);
  expect(events).toContain("contribute.revoked");

  tui.dispatch(key("a"));
  await settleApp(tui);
  expect(contributeOpen(app.db, repo.id)).toBe(false);
  expect(outsideAgentsCommands(session, tui.ctx, repo).length).toBe(1);
  off();
  tui.stop?.();
});

test("only a repository's admin has the screen's keys and its palette entry", async () => {
  const { tui, session } = open(bob);
  await settleApp(tui);
  expect(outsideAgentsCommands(session, tui.ctx, repo)).toEqual([]);
  expect(tui.screen.toText()).toContain("An admin of this repository manages outside agents.");
  tui.dispatch(key("a"));
  await settleApp(tui);
  expect(contributeOpen(app.db, repo.id)).toBe(false);
  tui.stop?.();
});
