/** The terminal's Account access screen: the page's gates, and a write that reaches the bus (#11688). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession, sessionUser } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("account access in the terminal", () => {
  let dataDir = "";
  let forge: App;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const { app } = createForgeApp(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
    app.start();
    const press = async (...keys: string[]) => {
      for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
      await settleApp(app);
    };
    const type = async (text: string) => press(...text.split(""));
    return { app, press, type, text: () => app.screen.toText() };
  }

  async function open(h: ReturnType<typeof boot>, name: string): Promise<void> {
    h.app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(h.app);
    await h.type("Account access");
    await h.press("enter");
    await h.press("/");
    await h.type(name);
    await h.press("enter");
    await settleUntil(h.app, name);
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-access-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, isAdmin] of [["alice", true], ["dave", true], ["bob", false]] as const) {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-access-passphrase", isAdmin });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person who is not an admin is offered nothing and sees nobody", async () => {
    const h = boot("bob");
    h.app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(h.app);
    await h.type("Account access");
    expect(h.text()).not.toContain("search people, reset access");
    h.app.stop();
  });

  test("search narrows the list; a reset after a confirm makes a link, ends sessions and reaches the bus", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const token = createSession(forge.db, bob.id).token;
    const kinds: string[] = [];
    const off = forge.bus.subscribe((e) => void kinds.push(e.kind));
    const h = boot("alice");
    await open(h, "bob");
    expect(h.text()).not.toContain("dave");
    await h.press("r");
    expect(h.text()).toContain("one-hour, one-use link");
    await h.press("esc");
    expect(sessionUser(forge.db, token).ok).toBe(true);
    await h.press("r", "left", "left", "enter");
    await settleUntil(h.app, "/signin/access/");
    expect(sessionUser(forge.db, token).ok).toBe(false);
    expect(kinds).toContain("account.access_reset");
    off();
    h.app.stop();
  });

  test("end all sessions asks first, and another admin is the owner's alone", async () => {
    const dave = boot("dave");
    await open(dave, "alice");
    await dave.press("e", "y");
    await settleUntil(dave.app, "only the forge's owner");
    dave.app.stop();

    const token = createSession(forge.db, getUserByName(forge.db, "bob")!.id).token;
    const h = boot("alice");
    await open(h, "bob");
    await h.press("e", "esc");
    expect(sessionUser(forge.db, token).ok).toBe(true);
    await h.press("e", "y");
    await settleUntil(h.app, "bob is signed out of");
    expect(sessionUser(forge.db, token).ok).toBe(false);
    h.app.stop();
  });
});
