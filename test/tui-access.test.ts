/**
 * The access log in the terminal (#1768): a forge admin's screen over
 * `readAccess` with its since / user agent / path filters; anyone else has
 * no such command and, if they reach the action, are told nothing exists.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { flushAccess, recordAccess } from "../src/http/access_log.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("the access log in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  const seen = (path: string, ua: string) => ({
    request: new Request(`http://forge.test${path}`, { headers: { "user-agent": ua } }),
    status: 200,
    ms: 3,
    client: "203.0.113.9",
  });

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
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-access-"));
    forge = createApp({ dataDir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(forge.db, {
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    forge.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE username = 'carol'").run();
    recordAccess(dataDir, seen("/api/v1/repos", "curl/8.0"));
    recordAccess(dataDir, seen("/llms.txt", "GPTBot/1.0"));
    flushAccess();
  });

  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Access");
    await h.press("enter");
  };

  test("an admin reads the log and filters it by user agent and path", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("GET /api/v1/repos");
    expect(h.text()).toContain("GET /llms.txt");

    await h.press("u");
    await h.type("gptbot");
    await h.press("enter");
    expect(h.text()).toContain("GET /llms.txt");
    expect(h.text()).not.toContain("GET /api/v1/repos");

    await h.press("c", "p");
    await h.type("/api/");
    await h.press("enter");
    expect(h.text()).toContain("GET /api/v1/repos");
    expect(h.text()).not.toContain("GET /llms.txt");

    // A time that is not one is refused and the prompt stays.
    await h.press("s");
    await h.type("yesterday-ish");
    await h.press("enter");
    expect(h.text()).toContain("not a time");
    h.stop();
  });

  test("a since in the future shows nothing", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("s");
    await h.type("2999-01-01T00:00");
    await h.press("enter");
    expect(h.text()).toContain("Nothing in the last day.");
    h.stop();
  });

  const palette = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Access");
    return h.text();
  };

  test("an admin's palette offers Access", async () => {
    const h = boot("alice");
    expect(await palette(h)).toContain("what outside agents tried");
    h.stop();
  });

  test("a person who is not an admin has no Access command", async () => {
    const h = boot("bob");
    expect(await palette(h)).not.toContain("what outside agents tried");
    await h.press("enter");
    expect(h.text()).not.toContain("GET /api/v1/repos");
    h.stop();
  });

  test("an admin who is an agent has no Access command", async () => {
    expect(getUserByName(forge.db, "carol")!.kind).toBe("agent");
    const h = boot("carol");
    expect(await palette(h)).not.toContain("what outside agents tried");
    await h.press("enter");
    expect(h.text()).not.toContain("GET /api/v1/repos");
    h.stop();
  });
});
