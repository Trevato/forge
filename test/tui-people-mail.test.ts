/** The People screen says, above the list, when mail is not configured — as the accounts page does. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { type User } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { NO_MAIL_LINE } from "../src/tui/screens/people.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

async function openPeople(forge: Forge, user: User) {
  const terminal = headlessTerminal(80, 30);
  const { app } = createForgeApp(forge, { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user }, { terminal, exitHooks: false });
  app.start();
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) app.dispatch({ type: "key", key, ctrl: false, alt: false, shift: false });
    await settleApp(app);
  };
  await settleApp(app);
  await press("ctrl+k");
  for (const ch of "People") await press(ch);
  await press("enter");
  await settleUntil(app, "alice");
  return { app, text: () => app.screen.toText() };
}

describe("the People screen and mail", () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  async function forgeWith(mail: boolean): Promise<{ forge: Forge; alice: User }> {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-tui-people-mail-"));
    dirs.push(dataDir);
    const forge = createApp({ dataDir, port: 0, ...(mail ? { mailer: async () => true } : {}) });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    if (!a.ok) throw new Error("signup failed");
    return { forge, alice: a.value };
  }

  let without: { forge: Forge; alice: User };
  let withMail: { forge: Forge; alice: User };
  beforeAll(async () => {
    without = await forgeWith(false);
    withMail = await forgeWith(true);
  });

  test("the line fits an 80-column terminal and names the key and the secret", () => {
    expect(NO_MAIL_LINE.length).toBeLessThanOrEqual(80);
    expect(NO_MAIL_LINE).toContain("with v");
    expect(NO_MAIL_LINE).toContain("MAIL_SMTP_URL");
  });

  test("without mail the line is drawn once, above the list", async () => {
    const h = await openPeople(without.forge, without.alice);
    try {
      const lines = h.text().split("\n");
      const at = lines.findIndex((l) => l.includes(NO_MAIL_LINE));
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines.filter((l) => l.includes("Mail is not configured")).length).toBe(1);
      expect(lines.findLastIndex((l) => l.includes("alice"))).toBeGreaterThan(at);
    } finally {
      h.app.stop();
    }
  });

  test("with mail configured nothing is drawn", async () => {
    const h = await openPeople(withMail.forge, withMail.alice);
    try {
      expect(h.text()).toContain("alice");
      expect(h.text()).not.toContain("Mail is not configured");
    } finally {
      h.app.stop();
    }
  });
});
