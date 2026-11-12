/**
 * App templates in the terminal: an admin marks and unmarks from a screen
 * (nobody else is offered it), and New app asks which template when more than
 * one is offered, goes straight to the form with one, and refuses a name that
 * is not offered or not readable.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { setRole } from "../src/actions/roles.ts";
import { createApp, type App } from "../src/app.ts";
import { offeredTemplates } from "../src/core/app_templates.ts";
import { listReposOwnedBy } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { blank } from "../src/tui/screens/common.ts";
import { appTemplatesScreen } from "../src/tui/screens/app_templates.ts";
import { newAppScreen } from "../src/tui/screens/newapp.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();
setDefaultTimeout(30_000);

let dir: string;
let app: App;
let admin: User;
let taker: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-apptpl-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  const mk = async (username: string, adminIfFirst = false) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@x.test`,
      password: "a-good-passphrase", adminIfFirst,
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  admin = await mk("giver", true);
  taker = await mk("taker");
  const trevato = await mk("trevato");
  setRole(app, admin, taker.username, "member");
  setRole(app, admin, trevato.username, "member");
  const make = async (owner: User, name: string, visibility: "public" | "private") => {
    const repo = await createRepo(app, owner, { name, visibility, description: "" });
    if (!repo.ok) throw new Error(repo.error);
    const done = await commitToBranch(app, owner, repo.value, {
      message: "t",
      files: [{ path: "README.md", content: `# ${name}\n` }],
    });
    if (!done.ok) throw new Error(String(done.error));
  };
  await make(trevato, "app-template", "public");
  await make(admin, "kit", "public");
  await make(admin, "secret", "private");
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!done() && Date.now() < deadline) await Bun.sleep(20);
  if (!done()) throw new Error("never came");
}

async function withScreen(
  user: User,
  make: (session: Session, ctx: Parameters<typeof newAppScreen>[1]) => ReturnType<typeof newAppScreen>,
  body: (h: { text: () => string; feed: (s: string) => Promise<void> }) => Promise<void>,
) {
  const terminal = headlessTerminal(120, 30);
  const { app: tui, session } = createForgeApp(app, identity(user), { terminal, exitHooks: false });
  tui.start();
  tui.ctx.push(make(session, tui.ctx));
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

const markScreen = (s: Session, c: Parameters<typeof newAppScreen>[1]) => appTemplatesScreen(s, c);
const newApp = (s: Session, c: Parameters<typeof newAppScreen>[1]) => newAppScreen(s, c, blank("New app"));

describe("the app templates screen", () => {
  test("only an admin is offered it", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(admin)).toContain("app-templates");
    expect(ids(taker)).not.toContain("app-templates");
    expect(ids({ ...admin, kind: "agent" })).not.toContain("app-templates");
    expect(ids()).not.toContain("app-templates");
  });

  test("a non-admin who reaches it sees the refusal and marks nothing", () =>
    withScreen(taker, markScreen, async ({ text, feed }) => {
      expect(text()).toContain("Only a site admin marks app templates.");
      await feed("m");
      await feed("giver/kit\r");
      expect(offeredTemplates(app.db, admin)).toEqual(["trevato/app-template"]);
    }));

  test("m marks, a missing name is refused in the action's words, u asks first then unmarks", () =>
    withScreen(admin, markScreen, async ({ text, feed }) => {
      await feed("m");
      await feed("giver/none\r");
      expect(text()).toContain("No repository by that name.");
      await feed("\x1b");
      await Bun.sleep(100);
      await feed("m");
      await feed("giver/kit\r");
      expect(offeredTemplates(app.db, admin)).toEqual(["trevato/app-template", "giver/kit"]);
      await feed("j");
      await feed("u");
      await feed("\x1b"); // esc keeps it
      await Bun.sleep(100);
      expect(offeredTemplates(app.db, admin)).toEqual(["trevato/app-template", "giver/kit"]);
      await feed("u");
      await feed("\x1b[C\r"); // right to Unmark, enter
      expect(offeredTemplates(app.db, admin)).toEqual(["trevato/app-template"]);
    }));
});

describe("the New app picker", () => {
  test("one offered goes straight to the form", () =>
    withScreen(taker, newApp, async ({ text }) => {
      expect(text()).toContain("What should it do?");
      expect(text()).not.toContain("Start from which template?");
    }));

  test("more than one offered asks which first, refuses a name not offered, and makes nothing", async () => {
    const { markTemplate } = await import("../src/actions/app_templates.ts");
    expect(markTemplate(app, admin, "giver/kit", true).ok).toBe(true);
    expect(markTemplate(app, admin, "giver/secret", true).ok).toBe(true);
    await withScreen(taker, newApp, async ({ text, feed }) => {
      expect(text()).toContain("Start from which template?");
      expect(text()).toContain("trevato/app-template");
      expect(text()).not.toContain("giver/secret");
      for (let i = 0; i < "trevato/app-template".length; i++) await feed("\x7f");
      await feed("giver/secret\r");
      expect(text()).toContain("Pick one of: trevato/app-template, giver/kit.");
      expect(listReposOwnedBy(app.db, taker.id)).toEqual([]);
      for (let i = 0; i < "giver/secret".length; i++) await feed("\x7f");
      await feed("giver/kit\r");
      expect(text()).toContain("New app from giver/kit");
    });
  });

  test("a named unreadable template is refused as no such template and makes nothing", () =>
    withScreen(taker, (s, c) => newAppScreen(s, c, blank("New app"), "giver/secret"), async ({ text, feed }) => {
      await feed("a plant waterer\r");
      await until(() => text().includes("No template by that name that you can read."));
      expect(listReposOwnedBy(app.db, taker.id)).toEqual([]);
    }));
});
