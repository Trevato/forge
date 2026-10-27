/** `s` on the terminal's People screen suspends or lifts, as MCP `account_suspend` does. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { ADMIN_WORDS } from "../src/actions/admin_words.ts";
import { createOrg, lastOwnerSays } from "../src/core/orgs.ts";
import { createSession, sessionUser } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

describe("suspending from the terminal's People screen", () => {
  let dataDir = "";
  let forge: App;

  const suspendedAt = (name: string) => getUserByName(forge.db, name)!.suspendedAt;

  function boot(username = "alice") {
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

  async function people(h: ReturnType<typeof boot>): Promise<void> {
    h.app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    await settleApp(h.app);
    await h.type("People");
    await h.press("enter");
    await settleUntil(h.app, "bob");
  }

  async function ask(h: ReturnType<typeof boot>, name: string): Promise<void> {
    await h.press("s");
    await h.type(name);
    await h.press("enter");
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-suspend-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, isAdmin] of [["alice", true], ["dave", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-suspend-passphrase", isAdmin });
      if (!made.ok) throw new Error(username);
    }
    if (!createOrg(forge.db, "acme", getUserByName(forge.db, "carol")!.id).ok) throw new Error("org");
  }, 30_000);

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a guest or a member is offered no People screen, and nobody changes", async () => {
    for (const name of ["bob", "carol"]) {
      const h = boot(name);
      h.app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
      await settleApp(h.app);
      await h.type("People");
      expect(h.text()).not.toContain("who is a guest, a member or an admin");
      await h.press("enter", "s");
      expect(h.text()).not.toContain("Suspend or lift");
      expect(suspendedAt("bob")).toBeNull();
      h.app.stop();
    }
  });

  test("esc at the confirm changes nothing", async () => {
    const h = boot();
    await people(h);
    await ask(h, "bob");
    expect(h.text()).toContain("sessions and tokens stop at once");
    await h.press("esc");
    expect(suspendedAt("bob")).toBeNull();
    h.app.stop();
  });

  test("a confirm suspends, signs the person out and marks the row; a second lifts it", async () => {
    const token = createSession(forge.db, getUserByName(forge.db, "bob")!.id).token;
    expect(sessionUser(forge.db, token).ok).toBe(true);
    const h = boot();
    await people(h);
    await ask(h, "bob");
    await h.press("left", "enter");
    await settleUntil(h.app, "bob is suspended.");
    expect(suspendedAt("bob")).not.toBeNull();
    expect(sessionUser(forge.db, token).ok).toBe(false);
    expect(h.text()).toMatch(/bob +guest +suspended 20\d\d-/);

    await ask(h, "bob");
    expect(h.text()).toContain("can sign in again");
    await h.press("left", "enter");
    await settleUntil(h.app, "bob is lifted.");
    expect(suspendedAt("bob")).toBeNull();
    h.app.stop();
  });

  test("yourself, another admin and the only owner of an organization are refused in MCP's words", async () => {
    const h = boot();
    await people(h);
    for (const [name, words] of [
      ["alice", ADMIN_WORDS.selfSuspend],
      ["dave", ADMIN_WORDS.selfSuspend],
      ["carol", lastOwnerSays(forge.db, "carol")],
    ] as const) {
      await ask(h, name);
      await h.press("left", "enter");
      await settleUntil(h.app, words.slice(0, 40));
      expect(suspendedAt(name)).toBeNull();
    }
    h.app.stop();
  });
});
