/** `v` on the People screen vouches for an email, as MCP `account_verify` does. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { listEvents } from "../src/core/events.ts";
import { listPeople } from "../src/core/roles.ts";
import { createUser, type User } from "../src/core/users.ts";
import { emailVerified, markUnproven, markVerified } from "../src/core/verify.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";
import { seedAdmin } from "./helpers/admin.ts";

quietLogs();

describe("verify an email from the People screen", () => {
  let dataDir: string;
  let forge: Forge;
  let alice: User;
  let bob: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-people-verify-"));
    forge = createApp({ dataDir, port: 0 });
    const a = await seedAdmin(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    const b = await createUser(forge.db, { username: "bobby", email: "bob@forge.test", password: "a-long-passphrase", origin: "seed" });
    if (!a.ok || !b.ok) throw new Error("signup failed");
    alice = a.value;
    bob = b.value;
    markUnproven(forge.db, bob.id);
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  async function open(user: User) {
    const terminal = headlessTerminal(120, 40);
    const { app } = createForgeApp(forge, { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user }, { terminal, exitHooks: false });
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
    return { app, press, text: () => app.screen.toText() };
  }

  test("an admin verifies the person under the cursor and the row changes", async () => {
    const h = await open({ ...alice });
    try {
      expect(h.text()).toMatch(/v +verify/);
      expect(h.text()).toMatch(/bobby.*unverified/);
      // newest first: bobby is the first row
      await h.press("v");
      expect(h.text()).toContain("verify bobby's email? y/n");
      await h.press("n");
      expect(emailVerified(forge.db, bob.id)).toBe(false);
      await h.press("v", "esc");
      expect(emailVerified(forge.db, bob.id)).toBe(false);
      expect(h.text()).not.toContain("y/n");
      await h.press("v", "y");
      expect(emailVerified(forge.db, bob.id)).toBe(true);
      expect(h.text()).not.toContain("unverified");
      expect(h.text()).toContain("bobby's email is verified.");
      expect(
        listEvents(forge.db, { kind: "account.email_verified" }).some(
          (e) => e.payload["username"] === "bobby" && e.payload["by"] === "owner",
        ),
      ).toBe(true);
      // already verified: refused, nothing changes
      await h.press("v", "y");
      expect(h.text()).toContain("already verified");
    } finally {
      h.app.stop();
    }
  }, 30_000);

  test("`r` still changes a role on the list", async () => {
    const h = await open({ ...alice });
    try {
      await h.press("j", "k", "r");
      for (const ch of "bobby") await h.press(ch);
      await h.press("enter");
      for (const ch of "member") await h.press(ch);
      await h.press("enter");
      expect(h.text()).toContain("bobby is a member.");
    } finally {
      h.app.stop();
    }
  }, 30_000);

  test("someone who is not a forge admin is refused and nothing changes", async () => {
    const carol = await createUser(forge.db, { username: "carol", email: "carol@forge.test", password: "a-long-passphrase", origin: "seed" });
    if (!carol.ok) throw new Error("signup failed");
    markUnproven(forge.db, carol.value.id);
    const me = { ...alice };
    const h = await open(me);
    try {
      me.isAdmin = false;
      await h.press("v", "y");
      expect(emailVerified(forge.db, carol.value.id)).toBe(false);
      expect(h.text()).toContain("Only a forge admin can verify an email.");
    } finally {
      h.app.stop();
    }
  }, 30_000);

  // Its own accounts, so its verdict never rests on the screen tests above.
  test("listPeople says who is verified", async () => {
    const proven = await createUser(forge.db, { username: "dora", email: "dora@forge.test", password: "a-long-passphrase", origin: "seed" });
    const unproven = await createUser(forge.db, { username: "evan", email: "evan@forge.test", password: "a-long-passphrase", origin: "seed" });
    if (!proven.ok || !unproven.ok) throw new Error("signup failed");
    markUnproven(forge.db, proven.value.id);
    markVerified(forge.db, proven.value.id, new Date().toISOString());
    markUnproven(forge.db, unproven.value.id);
    const byName = new Map(listPeople(forge.db).map((p) => [p.username, p.verified]));
    expect(byName.get("alice")).toBe(true);
    expect(byName.get("dora")).toBe(true);
    expect(byName.get("evan")).toBe(false);
  });
});
