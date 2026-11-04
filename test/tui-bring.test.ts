/** "Bring an app" in the terminal: offered to a person, never an agent; a bad link is answered in words. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser, type User } from "../src/core/users.ts";
import { createForgeApp, forgeCommands, Session } from "../src/tui/forge.ts";
import { bringScreen, bringWords } from "../src/tui/screens/bring.ts";
import { blank } from "../src/tui/screens/common.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

let dir: string;
let app: App;
let alice: User;

const identity = (user?: User) => ({
  sshUsername: user?.username ?? "git",
  remoteAddress: "127.0.0.1",
  fingerprint: "SHA256:test",
  user,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tui-bring-"));
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
});
afterAll(async () => {
  app.db.close();
  await rm(dir, { recursive: true, force: true });
});

describe("the bring screen", () => {
  test("the palette offers it to a person, never to an agent or a guest", () => {
    const ids = (u?: User) => forgeCommands(new Session(app, identity(u)))({} as never).map((c) => c.id);
    expect(ids(alice)).toContain("bring-app");
    expect(ids({ ...alice, kind: "agent" })).not.toContain("bring-app");
    expect(ids()).not.toContain("bring-app");
  });

  test("a link that is no repository, or a forge not connected, is answered in words", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(bringScreen(session, tui.ctx, blank("Bring an app")));
    try {
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("Link to the app");
      terminal.feed("nonsense\r");
      await settleApp(tui);
      expect(tui.screen.toText()).toContain("does not name a repository");
    } finally {
      tui.stop();
    }
    expect(bringWords({ kind: "connect", host: "codeberg.org" })).toContain("codeberg.org");
  });

  test("a link to a forge not yet connected asks for its token, masked, instead of a dead end", async () => {
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(bringScreen(session, tui.ctx, blank("Bring an app")));
    try {
      await settleApp(tui);
      terminal.feed("https://friend.example/ana/notes\r");
      await settleApp(tui);
      const text = tui.screen.toText();
      expect(text).toContain("Token for friend.example");
      expect(text).toContain("https://friend.example/settings/tokens");
      terminal.feed("s3cret-token\r");
      await settleApp(tui);
      expect(tui.screen.toText()).not.toContain("s3cret-token");
    } finally {
      tui.stop();
    }
  });

  test("plain http is refused in words, not asked a token for, off a development forge", async () => {
    const before = process.env.FORGE_DEV;
    process.env.FORGE_DEV = "0";
    const terminal = headlessTerminal(120, 30);
    const { app: tui, session } = createForgeApp(app, identity(alice), { terminal, exitHooks: false });
    tui.start();
    tui.ctx.push(bringScreen(session, tui.ctx, blank("Bring an app")));
    try {
      await settleApp(tui);
      terminal.feed("http://friend.example/ana/notes\r");
      await settleApp(tui);
      const text = tui.screen.toText();
      expect(text).toContain("plain http");
      expect(text).not.toContain("Token for friend.example");
    } finally {
      tui.stop();
      if (before === undefined) delete process.env.FORGE_DEV;
      else process.env.FORGE_DEV = before;
    }
  });
});
