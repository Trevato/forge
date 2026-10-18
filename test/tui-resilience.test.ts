/**
 * Resilience in the terminal (#1853): a forge admin's screen over
 * `listResilience`; anyone else has no such command and, if they reach the
 * action, are told nothing exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { recordDrill } from "../src/core/domain_drills.ts";
import { listResilience } from "../src/actions/resilience.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("resilience in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) =>
      app.dispatch({ type: "key", key: k, ctrl: k.startsWith("ctrl+"), alt: false, shift: false });
    const press = async (...keys: string[]) => {
      for (const k of keys) key(k.startsWith("ctrl+") ? k.slice(5) : k);
      await settleApp(app);
    };
    const ctrl = async (k: string) => {
      app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
      await settleApp(app);
    };
    const type = async (text: string) => {
      for (const ch of text) key(ch);
      await settleApp(app);
    };
    return { text: () => app.screen.toText(), press, ctrl, type, stop: () => app.stop() };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-resilience-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
    recordDrill(forge.db, "alice", "runner", { health: "", board: "" }, 900, {
      green: false,
      why: "late by 5 minutes",
    });
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const palette = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Failure domains");
    return h.text();
  };

  test("an admin reads each domain and its last drill", async () => {
    const h = boot("alice");
    expect(await palette(h)).toContain("failure domains and their last drill");
    await h.press("enter");
    expect(h.text()).toContain("Failure domains");
    expect(h.text()).not.toContain("Resilience");
    expect(h.text()).toContain("The runner");
    expect(h.text()).toContain("red");
    expect(h.text()).toContain("not drilled");
    h.stop();
  });

  test("a person who is not an admin has no Failure domains command", async () => {
    const h = boot("bob");
    expect(await palette(h)).not.toContain("failure domains and their last drill");
    await h.press("enter");
    expect(h.text()).not.toContain("The runner");
    h.stop();
  });

  test("the action tells a non-admin and an agent nothing exists", () => {
    for (const name of ["bob", "carol"]) {
      const user = getUserByName(forge.db, name)!;
      const listed = listResilience(forge, user);
      expect(listed.ok).toBe(false);
    }
  });
});
