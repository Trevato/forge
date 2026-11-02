/** The notify screen's `t`: a test line to the saved URL, and whether it arrived (#8081). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { TEST_LINE, claimTest, sendTest, setNotifyUrl, type Sender } from "../src/crew/notify.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { testSender } from "../src/tui/screens/notify.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const URL_ = "https://ntfy.example.com/secret-topic-123";

describe("send a test push", () => {
  let dataDir: string;
  let app: App;
  let id: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-notify-test-"));
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
    id = getUserByName(app.db, "alice")!.id;
  });
  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  test("off, sent, refused, and a throwing sender", async () => {
    const calls: string[] = [];
    const ok: Sender = async (u, body) => (calls.push(u, body), true);
    expect(await sendTest(app.db, id, ok)).toBe("off");
    expect(calls).toEqual([]);
    setNotifyUrl(app.db, id, URL_);
    expect(await sendTest(app.db, id, ok)).toBe("sent");
    expect(calls).toEqual([URL_, TEST_LINE]);
    expect(await sendTest(app.db, id, async () => false)).toBe("refused");
    expect(
      await sendTest(app.db, id, async () => {
        throw new Error("boom");
      }),
    ).toBe("refused");
  });

  test("one per user per 30 seconds", () => {
    expect(claimTest("u1", 1_000)).toBe(true);
    expect(claimTest("u1", 20_000)).toBe(false);
    expect(claimTest("u2", 20_000)).toBe(true);
    expect(claimTest("u1", 31_001)).toBe(true);
  });

  test("t in the terminal toasts the result, then the wait", async () => {
    setNotifyUrl(app.db, id, URL_);
    const terminal = headlessTerminal(140, 32);
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(app.db, "alice")! },
      { terminal, exitHooks: false },
    );
    tui.start();
    const key = async (k: string, ctrl = false) => {
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      await settleApp(tui);
    };
    const sent: string[] = [];
    const saved = testSender.current;
    testSender.current = async (u) => (sent.push(u), false);
    try {
      await key("k", true);
      for (const ch of "Phone notifications") await key(ch);
      await key("enter");
      expect(tui.screen.toText()).toContain("send a test");
      await key("t");
      expect(sent).toEqual([URL_]);
      expect(tui.screen.toText()).toContain("ntfy.example.com did not take it");
      expect(tui.screen.toText()).not.toContain("secret-topic");
      await key("t");
      expect(sent.length).toBe(1);
      expect(tui.screen.toText()).toContain("just sent — wait a moment");
    } finally {
      testSender.current = saved;
      tui.stop();
    }
  });
});
