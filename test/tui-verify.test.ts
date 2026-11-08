/**
 * "What I can do" in the terminal says when the email is unverified, and `v`
 * sends another link through `resendVerification`, as MCP `email_verify`
 * does: the same limit, the API's words, never the link (#7301).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { VERIFY_WORDS } from "../src/actions/verify_words.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { markVerified, resetVerification } from "../src/core/verify.ts";
import type { Mail } from "../src/kernel/mail.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const LINE = "Your email is not verified";

describe("the terminal's unverified-email line and v", () => {
  let dataDir: string;
  let forge: Forge;
  const sent: Mail[] = [];

  async function shown(username: string, presses: string[] = []): Promise<string> {
    const terminal = headlessTerminal(240, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
    for (const ch of "What I can do") key(ch);
    key("enter");
    await settleApp(app);
    for (const k of presses) {
      key(k);
      await settleApp(app);
    }
    const text = app.screen.toText();
    app.stop();
    return text;
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-verify-"));
    forge = createApp({
      dataDir,
      port: 0,
      url: "https://forge.example",
      mailer: async (mail) => {
        sent.push(mail);
        return true;
      },
    });
    for (const [username, adminIfFirst] of [["alice", true], ["newt", false], ["robo", false]] as const) {
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
    resetVerification(forge.db, getUserByName(forge.db, "newt")!.id);
    const stand = await createUser(forge.db, {
      origin: "seed",
      trusted: true,
      username: "nomail",
      email: "nomail@users.forge.invalid",
      password: "a-good-passphrase",
    });
    if (!stand.ok) throw new Error(stand.error);
    resetVerification(forge.db, stand.value.id);
    const bot = getUserByName(forge.db, "robo")!;
    forge.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(bot.id);
    resetVerification(forge.db, bot.id);
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("unverified shows the line; v sends one mail; a second within the limit is refused in words", async () => {
    const before = await shown("newt");
    expect(before).toContain(LINE);
    expect(before).toContain("v sends another link");
    expect(sent.length).toBe(0);

    const first = await shown("newt", ["v"]);
    expect(sent.length).toBe(1);
    expect(sent[0]!.to).toBe("newt@forge.local");
    expect(first).toContain("A new verification email is on its way.");
    expect(first).not.toContain("token=");

    const second = await shown("newt", ["v"]);
    expect(sent.length).toBe(1);
    expect(second).toContain(VERIFY_WORDS.too_soon);
    expect(second).not.toContain("token=");
  });

  test("verified shows nothing, and v sends nothing", async () => {
    markVerified(forge.db, getUserByName(forge.db, "newt")!.id, new Date().toISOString());
    const before = sent.length;
    const screen = await shown("newt", ["v"]);
    expect(screen).not.toContain(LINE);
    expect(screen).not.toContain("verification email");
    expect(sent.length).toBe(before);
    expect(await shown("alice")).not.toContain(LINE);
  });

  test("an agent is never offered v", async () => {
    const before = sent.length;
    const screen = await shown("robo", ["v"]);
    expect(screen).not.toContain(LINE);
    expect(screen).not.toContain("verification email");
    expect(sent.length).toBe(before);
  });

  test("a placeholder address is told to add an email in a browser, and v sends nothing", async () => {
    const before = sent.length;
    const screen = await shown("nomail", ["v"]);
    expect(screen).toContain(LINE);
    expect(screen).toContain("add your email from account settings in a browser");
    expect(screen).not.toContain("v sends another link");
    expect(screen).not.toContain("send another verification email");
    expect(screen).not.toContain("verification email is on its way");
    expect(sent.length).toBe(before);
  });
});
