/**
 * The deploys screen's `i`: an app's prompt source. An admin connects an
 * account (the token typed masked, in no frame), fetches now through a fake
 * Instagram, removes it after a confirm; a reader and a guest are not
 * offered `i`.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPromptSource, listPromptSources, removePromptSource } from "../src/actions/prompts.ts";
import { createUser, getUserById } from "../src/core/users.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { listEvents } from "../src/core/events.ts";
import { createRepo } from "../src/actions/repos.ts";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { startPromptRoutine, type PromptRoutineHandle } from "../src/crew/prompts.ts";
import type { InstagramClient } from "../src/crew/instagram.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { deploysScreen } from "../src/tui/screens/deploys.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

const TOKEN = "IGAAtokenSECRET0123456789";

let dir: string;
let forge: Forge;
let routine: PromptRoutineHandle;
let alice: User;
let bob: User;
let repo: Repo;
let bot: User;
let asked = 0;
let hold: Promise<void> = Promise.resolve();

/** The action's injectable fetch: Instagram is this stub, never the network. */
const instagram: InstagramClient = {
  me: async () => {
    asked += 1;
    await hold;
    return { id: "1", username: "handle" };
  },
  latestReel: () => Promise.resolve(undefined),
  comments: () => Promise.resolve([]),
  refresh: () => Promise.resolve({ token: "fresh" }),
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-prompts-"));
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
  const r = await createRepo(forge, alice, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error("repo failed");
  repo = r.value;
  const made = await createUser(forge.db, { username: "bot", email: "bot@forge.test", agent: true, origin: "agent" });
  if (!made.ok) throw new Error(made.error);
  createAgentRow(forge.db, { userId: made.value.id, brief: "bot." });
  // A site-admin agent: the action would let it in, the screen must not.
  forge.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
  bot = getUserById(forge.db, made.value.id)!;
  routine = startPromptRoutine(forge, { client: instagram, everyMs: 3_600_000 });
});

afterAll(async () => {
  await routine?.stop();
  forge.close?.();
  await rm(dir, { recursive: true, force: true });
});

const drive = async (who: User | null, of: Repo = repo) => {
  const { app, session } = createForgeApp(
    forge,
    { sshUsername: who?.username ?? "guest", remoteAddress: "127.0.0.1", ...(who === null ? {} : { user: who }) },
    { terminal: headlessTerminal(160, 40), exitHooks: false },
  );
  app.start();
  await settleApp(app);
  app.push(deploysScreen(session, app.ctx, of));
  await settleApp(app);
  const frames = [app.screen.toText()];
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
      await settleApp(app);
      frames.push(app.screen.toText());
    }
  };
  const type = async (text: string) => {
    for (const ch of text) {
      app.dispatch({ type: "key", key: ch, ctrl: false, alt: false, shift: false });
      frames.push(app.screen.toText());
    }
    await settleApp(app);
    frames.push(app.screen.toText());
  };
  return { app, session, frames, press, type, text: () => app.screen.toText() };
};

test("a reader and a guest are not offered i", async () => {
  for (const who of [bob, null]) {
    const t = await drive(who);
    expect(t.text()).not.toContain("prompt source");
    await t.press("i");
    expect(t.text()).not.toContain("Connect Instagram");
    expect(t.text()).not.toContain("No account connected");
    t.app.stop();
  }
});

test("an agent admin is not offered i and it does nothing", async () => {
  const t = await drive(bot, repo);
  await t.press("i");
  expect(t.text()).not.toContain("No account connected");
  expect(t.text()).not.toContain("Not yours");
  expect(t.text()).toContain("production deploys");
  t.app.stop();
});

test("the key hint shows for the admin only", async () => {
  const hint = async (who: User | null, of: Repo): Promise<boolean> => {
    const t = await drive(who, of);
    const screen = deploysScreen(t.session, t.app.ctx, of);
    await screen.load?.(new AbortController().signal);
    const shown = screen.keys.some((k) => k.keys.includes("i"));
    t.app.stop();
    return shown;
  };
  expect(await hint(alice, repo)).toBe(true);
  expect(await hint(bob, repo)).toBe(false);
  expect(await hint(null, repo)).toBe(false);
  expect(await hint(bot, repo)).toBe(false);
});

test("the admin connects, fetches now and removes after a confirm; no frame holds the token", async () => {
  const t = await drive(alice);
  await t.press("i");
  expect(t.text()).toContain("No account connected");

  await t.press("a");
  await t.type(TOKEN);
  await t.press("enter");
  expect(t.text()).toContain("Every day at");
  await t.press("enter");
  expect(t.text()).toContain("every day at 15:00 UTC");
  expect(t.text()).toContain("Has not run yet.");
  expect(listPromptSources(forge, alice, repo)).toMatchObject({ ok: true, value: [{ kind: "instagram" }] });

  // Once an account exists the screen does not offer `a`: it does nothing.
  await t.press("a");
  expect(t.text()).not.toContain("Connect Instagram");

  // Two quick presses ask Instagram once.
  let release: () => void = () => {};
  hold = new Promise<void>((r) => (release = r));
  const before = asked;
  t.app.dispatch({ type: "key", key: "f", ctrl: false, alt: false, shift: false });
  t.app.dispatch({ type: "key", key: "f", ctrl: false, alt: false, shift: false });
  release();
  await settleApp(t.app);
  hold = Promise.resolve();
  expect(asked).toBe(before + 1);
  t.frames.push(t.text());
  expect(t.text()).toContain("@handle");
  expect(t.text()).toContain("Last ran");

  // The web's reader sees the same source, with no token in it.
  const seen = listPromptSources(forge, alice, repo);
  expect(seen).toMatchObject({ ok: true, value: [{ kind: "instagram", account: "handle" }] });
  expect(JSON.stringify(seen)).not.toContain(TOKEN);
  expect(t.text()).toContain("@handle");
  expect(t.text()).toContain("Last ran");

  await t.press("d");
  expect(t.text()).toContain("remove @handle? y/n");
  await t.press("n");
  expect(listPromptSources(forge, alice, repo)).toMatchObject({ ok: true, value: [{}] });
  await t.press("d", "y");
  expect(listPromptSources(forge, alice, repo)).toMatchObject({ ok: true, value: [] });
  expect(t.text()).toContain("No account connected");

  const kinds = listEvents(forge.db, { repoId: repo.id }).map((e) => e.kind);
  expect(kinds).toContain("prompt.source_added");
  expect(kinds).toContain("prompt.source_removed");
  expect(t.frames.some((f) => f.includes(TOKEN))).toBe(false);
  t.app.stop();
});

test("a bad token is refused in the action's words", async () => {
  const t = await drive(alice);
  await t.press("i", "a");
  await t.type("two words");
  await t.press("enter", "enter");
  expect(t.text()).toContain("Paste the long-lived token");
  t.app.stop();
});

test("a source connected on the web while the screen is open is refused in the page's words", async () => {
  const t = await drive(alice);
  await t.press("i");
  expect(t.text()).toContain("No account connected");
  const web = addPromptSource(forge, alice, repo, { kind: "instagram", token: TOKEN, at: "10:00" });
  expect(web.ok).toBe(true);
  await t.press("a");
  await t.type(TOKEN);
  await t.press("enter", "enter");
  expect(t.text()).toContain("An Instagram account is already connected here.");
  const listed = listPromptSources(forge, alice, repo);
  expect(listed).toMatchObject({ ok: true, value: [{ atUtc: "10:00" }] });
  if (listed.ok) removePromptSource(forge, alice, repo, listed.value[0]!.id);
  t.app.stop();
});
