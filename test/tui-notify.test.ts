/** Phone notifications in the terminal (#7258): host only, never the path. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { NOTIFY_ERRORS, notifyUrlOf } from "../src/crew/notify.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const URL_ = "https://ntfy.example.com/secret-topic-123?auth=hunter2";

describe("phone notifications in the terminal", () => {
  let dataDir: string;
  let app: App;
  const frames: string[] = [];

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const h = {
      text: () => {
        const t = tui.screen.toText();
        frames.push(t);
        return t;
      },
      press: async (...keys: string[]) => {
        keys.forEach((k) => key(k));
        await settleApp(tui);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(tui);
      },
      palette: async (q: string) => {
        key("k", true);
        await settleApp(tui);
        await h.type(q);
      },
      open: async () => {
        await h.palette("Phone notifications");
        await h.press("enter");
      },
      stop: () => tui.stop(),
    };
    return h;
  }
  const url = () => notifyUrlOf(app.db, getUserByName(app.db, "alice")!.id);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-notify-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const bot = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "helper",
      email: "helper@forge.local",
      password: "a-good-passphrase",
    });
    if (!bot.ok) throw new Error(bot.error);
    app.db.query("UPDATE user SET is_agent = 1 WHERE username = 'helper'").run();
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("off, refuse a bad URL, set, read back as host only, turn off", async () => {
    const h = boot("alice");
    await h.open();
    expect(h.text()).toContain("Off.");

    await h.press("s");
    await h.type("http://ntfy.example.com/t");
    await h.press("enter");
    expect(h.text()).toContain(NOTIFY_ERRORS.not_https);
    expect(url()).toBeUndefined();
    await h.press("esc");

    await h.press("s");
    await h.type(URL_);
    const typing = h.text();
    expect(typing).not.toContain("secret-topic");
    expect(typing).not.toContain("hunter2");
    await h.press("enter");
    expect(url()).toBe(URL_);
    expect(h.text()).toContain("notifications go to ntfy.example.com");

    await h.press("x");
    expect(h.text()).toContain("Stop sending to ntfy.example.com?");
    await h.press("esc");
    expect(url()).toBe(URL_);
    await h.press("x", "right", "enter");
    expect(url()).toBeUndefined();
    expect(h.text()).toContain("Off.");
    h.stop();
  });

  test("x when already off says so", async () => {
    const h = boot("alice");
    await h.open();
    await h.press("x");
    expect(h.text()).toContain("Already off.");
    h.stop();
  });

  test("an agent is never offered the screen", async () => {
    const h = boot("helper");
    await h.palette("Phone notifications");
    expect(h.text()).not.toContain("where the crew reaches your phone");
    h.stop();
  });

  test("no frame ever shows the path or query", () => {
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f).not.toContain("secret-topic");
      expect(f).not.toContain("hunter2");
    }
  });
});
