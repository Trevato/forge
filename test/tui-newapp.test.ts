/**
 * "New app" in the terminal: a sentence makes an app named from it, an empty
 * one gets the no-name words, and an agent is never offered the entry.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_NAME_ERROR } from "../src/actions/apps.ts";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/actions/orgs.ts";
import { getOrg } from "../src/core/orgs.ts";
import { getRepo, listReposOwnedBy } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { blank } from "../src/tui/screens/common.ts";
import { newAppScreen } from "../src/tui/screens/newapp.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;
let nell: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-newapp-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    adminIfFirst: true,
    email: "alice@forge.local",
    password: "a-good-passphrase",
  });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  const plain = await createUser(app.db, {
    origin: "seed",
    username: "nell",
    email: "nell@forge.local",
    password: "a-good-passphrase",
  });
  if (!plain.ok) throw new Error(plain.error);
  nell = plain.value;
  const org = createOrg(app, alice, "acme");
  if (!org.ok) throw new Error(org.error);
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done() && Date.now() < deadline) await Bun.sleep(20);
  if (!done()) throw new Error(`never came: still waiting while !done()`);
}

async function withScreen(
  user: User,
  body: (h: { text: () => string; feed: (s: string) => Promise<void> }) => Promise<void>,
) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(newAppScreen(session, tui.ctx, blank("New app")));
  try {
    await settleApp(tui);
    await body({
      text: () => tui.screen.toText(),
      feed: async (s) => {
        terminal.feed(s);
        await settleApp(tui);
      },
    });
  } finally {
    tui.stop();
  }
}

describe("the new app screen", () => {
  test("the palette offers it to a signed-in person, never to an agent or a guest", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(alice)).toContain("new-app");
    expect(ids({ ...alice, kind: "agent" })).not.toContain("new-app");
    expect(ids()).not.toContain("new-app");
  });

  test("a sentence makes an app named from it, and lands on its repository", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("a shared shopping list\r");
      await feed("\r"); // alice is in an organization: accept the prefilled owner
      await until(() => getRepo(app.db, "alice", "shared-shopping") !== undefined);
      await feed("");
      const repo = getRepo(app.db, "alice", "shared-shopping");
      expect(repo).toBeDefined();
      expect(text()).toContain("shared-shopping");
    }));

  test("an empty sentence shows the no-name words and makes nothing", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("\r");
      expect(text()).toContain(NO_NAME_ERROR.slice(0, 40));
      await feed("!!!\r");
      expect(text()).toContain(NO_NAME_ERROR.slice(0, 40));
    }));

  test("a person in an organization is asked for the owner, refused one not in the list, and the app is made under the pick", () =>
    withScreen(alice, async ({ text, feed }) => {
      await feed("a recipe box for the bakery\r");
      expect(text()).toContain("Under which owner? alice, acme");
      for (let i = 0; i < "alice".length; i++) await feed("\x7f");
      await feed("mallory\r");
      expect(text()).toContain("Pick one of: alice, acme.");
      expect(getRepo(app.db, "mallory", "recipe-box-bakery")).toBeUndefined();
      for (let i = 0; i < "mallory".length; i++) await feed("\x7f");
      await feed("acme\r");
      await until(() => listReposOwnedBy(app.db, getOrg(app.db, "acme")!.id).length > 0);
      expect(listReposOwnedBy(app.db, getOrg(app.db, "acme")!.id).length).toBe(1);
      expect(listReposOwnedBy(app.db, alice.id).some((r) => r.name.includes("recipe"))).toBe(false);
    }));

  test("a refusal shows its words and makes nothing", () =>
    withScreen(nell, async ({ text, feed }) => {
      await feed("a plant waterer\r");
      await until(() => text().includes("That app could not be created."));
      expect(text()).toContain("That app could not be created.");
      expect(listReposOwnedBy(app.db, nell.id)).toEqual([]);
      expect(text()).not.toContain("is starting at");
    }));
});
