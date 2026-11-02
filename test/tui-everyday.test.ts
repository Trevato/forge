/** The terminal's dashboard asks an admin once to work day to day as an everyday account, as the web home does (#8046). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../src/actions/crew.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { askForEveryday, keptAdmin, linkEveryday } from "../src/core/everyday.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const ASK = "K keeps using admin";
const WHY_START = "Admin can change everything here";

let dir: string;
let forge: Forge;
let alice: User;
let bob: User;

async function person(username: string, isAdmin = false): Promise<User> {
  const made = await createUser(forge.db, {
    origin: "seed",
    trusted: true,
    username,
    email: `${username}@forge.test`,
    password: "a-long-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
  if (isAdmin) forge.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.id);
  return getUserByName(forge.db, username)!;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-everyday-"));
  forge = createApp({ dataDir: dir, port: 0 });
  const a = await seedAdmin(forge, { username: "alice", email: "a@forge.test", password: "a-long-passphrase" });
  if (!a.ok) throw new Error("signup failed");
  alice = a.value;
  bob = await person("bob");
});

afterAll(async () => {
  forge.close();
  await rm(dir, { recursive: true, force: true });
});

function boot(user: User) {
  const terminal = headlessTerminal(240, 32);
  const { app } = createForgeApp(
    forge,
    { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:t", user },
    { terminal, exitHooks: false },
  );
  app.start();
  return {
    text: () => app.screen.toText(),
    settle: () => settleApp(app),
    press: async (key: string) => {
      app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    },
    stop: () => app.stop(),
  };
}

async function firstScreen(user: User): Promise<string> {
  const h = boot(user);
  await h.settle();
  const text = h.text();
  h.stop();
  return text;
}

test("an admin with no choice made sees the line at the head; K keeps admin and the line goes for good", async () => {
  expect(askForEveryday(forge.db, alice)).toBe(true);
  const h = boot(alice);
  await h.settle();
  const head = h.text().split("\n").find((line) => line.includes(WHY_START));
  expect(head).toBeDefined();
  expect(head).toContain("E makes it on the web · K keeps using admin");

  // `k` still moves the cursor: it never makes the choice.
  await h.press("k");
  expect(keptAdmin(forge.db, alice)).toBe(false);
  expect(h.text()).toContain(ASK);

  await h.press("K");
  expect(keptAdmin(forge.db, alice)).toBe(true);
  expect(h.text()).not.toContain(WHY_START);
  h.stop();

  // The choice is the web's too: a fresh session is not asked again.
  expect(askForEveryday(forge.db, alice)).toBe(false);
  expect(await firstScreen(alice)).not.toContain(WHY_START);
});

test("an admin with an everyday account linked is told its name instead", async () => {
  const carol = await person("carol", true);
  const daily = await person("dana");
  linkEveryday(forge.db, carol, daily);
  const text = await firstScreen(carol);
  expect(text).toContain("Day to day you are dana; this is the admin account.");
  expect(text).not.toContain(ASK);
  // The everyday account itself is not an admin, and is asked nothing.
  expect(await firstScreen(daily)).not.toContain("Day to day");
});

test("a non-admin and an agent never see the line", async () => {
  expect(await firstScreen(bob)).not.toContain(WHY_START);
  const made = await createAgent(forge, alice, { username: "everydaybot" });
  if (!made.ok) throw new Error(String(made.error));
  // Even an agent made an admin is not asked: the everyday account is a person's.
  forge.db.query("UPDATE user SET is_admin = 1 WHERE username = 'everydaybot'").run();
  const agent = getUserByName(forge.db, "everydaybot")!;
  expect(agent.isAdmin).toBe(true);
  expect(agent.kind).toBe("agent");
  const text = await firstScreen(agent);
  expect(text).not.toContain(WHY_START);
  expect(text).not.toContain("Day to day");
});
