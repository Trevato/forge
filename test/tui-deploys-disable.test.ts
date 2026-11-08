/**
 * The deploys screen stops running a repository as an app (#8032): `X`, after
 * typing `<owner>/<name>`, calls `disableApp` as Settings does. Only an admin
 * who is a person is offered it; a wrong name changes nothing. Runs against a
 * temporary data directory.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { addTeamMember, createOrg, createTeam } from "../src/actions/orgs.ts";
import { getOrg } from "../src/core/orgs.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createUser, getUserById } from "../src/core/users.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { createApp as createAppRecord, getAppByRepo } from "../src/core/apps.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { settleApp } from "./helpers/tui.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;
let bot: User;
let lamp: Repo;
let kiln: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-deploys-disable-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  const b = await signUp(
    forge,
    { username: "bob", email: "bob@forge.test", password: "a-long-passphrase" },
    { slot: fixtureSlot(forge) },
  );
  if (!b.ok) throw new Error("signup failed");
  bob = b.value;
  proveAll(forge);
  // A site-admin agent: disableApp would let it in, the screen must not offer X.
  const made = await createUser(forge.db, { username: "bot", email: "bot@forge.test", agent: true, origin: "agent" });
  if (!made.ok) throw new Error(made.error);
  createAgentRow(forge.db, { userId: made.value.id, brief: "bot." });
  forge.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
  bot = getUserById(forge.db, made.value.id)!;
  // Bob writes to kiln, an org's repository, without administering it.
  if (!createOrg(forge, alice, "acme").ok) throw new Error("org failed");
  const acme = getOrg(forge.db, "acme")!;
  const devs = createTeam(forge, alice, acme, "devs", "write");
  if (!devs.ok || !addTeamMember(forge, alice, acme, devs.value, "bob").ok) throw new Error("team failed");
  for (const name of ["lamp", "kiln"]) {
    const r = await createRepo(forge, alice, { name, visibility: "public", ...(name === "kiln" ? { owner: "acme" } : {}) });
    if (!r.ok) throw new Error("repo failed");
    const made = createAppRecord(forge.db, { repoId: r.value.id, slug: name, access: "public" });
    if (!made.ok) throw new Error(made.error);
    if (name === "lamp") lamp = r.value;
    else kiln = r.value;
  }
});
afterAll(async () => {
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const open = async (who: User, of: Repo) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who.username, remoteAddress: "127.0.0.1", user: who },
    { terminal: headlessTerminal(200, 30), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  const toasts: string[] = [];
  const toast = app.toast.bind(app);
  app.toast = (text, tone) => {
    toasts.push(text);
    toast(text, tone);
  };
  const screen = deploysScreen(session, app.ctx, of);
  app.push(screen);
  await settleApp(app);
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  return { app, press, toasts, keys: () => screen.keys.map((k) => k.help), text: () => app.screen.toText() };
};

test("a wrong name is refused and the app stays", async () => {
  const h = await open(alice, lamp);
  expect(h.keys()).toContain("stop running as an app");
  await h.press("X");
  expect(h.text()).toContain("code stays.");
  await h.press(..."alice/lam".split(""), "enter");
  expect(h.text()).toContain("Type alice/lamp to confirm.");
  expect(getAppByRepo(forge.db, lamp.id)).toBeDefined();
  h.app.stop();
});

test("typing the name removes the app record and the screen says so", async () => {
  const h = await open(alice, lamp);
  await h.press("X", ..."alice/lamp".split(""), "enter");
  expect(getAppByRepo(forge.db, lamp.id)).toBeUndefined();
  expect(h.toasts).toContain("no longer an app");
  expect(h.text()).toContain("This repository is no longer an app.");
  expect(h.keys()).not.toContain("stop running as an app");
  h.app.stop();
});

test("a writer who is not an admin is not offered X", async () => {
  const h = await open(bob, kiln);
  expect(h.keys()).not.toContain("stop running as an app");
  await h.press("X");
  expect(h.text()).not.toContain("Type acme/kiln");
  expect(getAppByRepo(forge.db, kiln.id)).toBeDefined();
  h.app.stop();
});

test("an agent admin is not offered X and it does nothing", async () => {
  const h = await open(bot, kiln);
  expect(h.keys()).not.toContain("stop running as an app");
  await h.press("X");
  expect(h.text()).not.toContain("Type acme/kiln");
  expect(getAppByRepo(forge.db, kiln.id)).toBeDefined();
  h.app.stop();
});
