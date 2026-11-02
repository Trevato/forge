/**
 * Invite links in the terminal (#2337): an admin who is a person lists the
 * links, makes one (shown once) and revokes one; anyone else has no command and, driving the screen directly,
 * can neither read nor write.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App as Forge } from "../src/app.ts";
import { listInvites, mintInvite, redeemInvite } from "../src/core/invites.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { invitesScreen } from "../src/tui/screens/invites.ts";
import { Session, type TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("invite links in the terminal", () => {
  let dataDir: string;
  let forge: Forge;

  function boot(username: string) {
    const terminal = headlessTerminal(140, 32);
    const user = getUserByName(forge.db, username)!;
    const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
    const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
    app.start();
    const key = (k: string) =>
      app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => app.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(app);
      },
      ctrl: async (k: string) => {
        app.dispatch({ type: "key", key: k, ctrl: true, alt: false, shift: false });
        await settleApp(app);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(app);
      },
      stop: () => app.stop(),
    };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-tui-invites-"));
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
  });
  afterAll(async () => {
    forge.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const open = async (h: ReturnType<typeof boot>) => {
    await h.ctrl("k");
    await h.type("Invite links");
    await h.press("enter");
  };

  test("an admin makes a link, sees it once, lists it and revokes it", async () => {
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("No invite link yet");
    await h.press("m");
    await h.press("enter");
    expect(forge.config.url).toBeUndefined();
    expect(h.text()).toMatch(/Shown once: http:\/\/localhost:\d+\/signup\?invite=invite_/);
    const [made] = listInvites(forge.db);
    expect(made!.state).toBe("open");
    expect(h.text()).toContain(made!.id);
    expect(h.text()).toContain("open");
    await h.press("j");
    expect(h.text()).not.toContain("invite_");
    await h.press("x");
    expect(h.text()).toContain(`Revoke invite ${made!.id}?`);
    expect(h.text()).not.toContain("invite_");
    expect(listInvites(forge.db)[0]!.state).toBe("open");
    await h.press("y");
    expect(listInvites(forge.db)[0]!.state).toBe("revoked");
    expect(h.text()).toContain(`Revoked ${made!.id}.`);
    expect(h.text()).not.toContain("invite_");
    await h.press("x");
    expect(h.text()).not.toContain("Revoke invite");
    expect(h.text()).toContain("not open");
    h.stop();
  });

  test("n or esc on the revoke confirm keeps the link open", async () => {
    const h = boot("alice");
    await open(h);
    await h.press("m");
    await h.press("enter");
    const made = listInvites(forge.db).find((i) => i.state === "open")!;
    for (const k of ["n", "esc"]) {
      await h.press("x");
      expect(h.text()).toContain(`Revoke invite ${made.id}?`);
      expect(h.text()).toContain(`Expires ${made.expiresAt.slice(0, 10)}; holder can no longer sign up.`);
      expect(h.text()).not.toContain("invite_");
      await h.press(k);
      expect(h.text()).not.toContain("Revoke invite");
      expect(listInvites(forge.db).find((i) => i.id === made.id)!.state).toBe("open");
    }
    h.stop();
  });

  test("days outside 1 to 30 make nothing", async () => {
    const before = listInvites(forge.db).length;
    const h = boot("alice");
    await open(h);
    await h.press("m");
    await h.press("backspace");
    await h.type("0");
    await h.press("enter");
    expect(h.text()).toContain("1 to 30");
    expect(listInvites(forge.db).length).toBe(before);
    h.stop();
  });

  test("a non-admin and an admin agent have no command and mint nothing", async () => {
    const before = listInvites(forge.db).length;
    for (const who of ["bob", "carol"]) {
      const h = boot(who);
      await h.ctrl("k");
      await h.type("Invite links");
      expect(h.text()).not.toContain("single-use link");
      h.stop();
      const user = getUserByName(forge.db, who)!;
      const session = new Session(forge, { sshUsername: "t", remoteAddress: "127.0.0.1", user });
      const pushed: unknown[] = [];
      const ctx = { push: (s: unknown) => pushed.push(s), invalidate() {} } as never;
      const screen = invitesScreen(session, ctx);
      const key = (k: string) => screen.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
      key("m");
      key("x");
      expect(pushed).toEqual([]);
    }
    expect(listInvites(forge.db).length).toBe(before);
  });

  test("a used link says who joined with it and when", async () => {
    const bob = getUserByName(forge.db, "bob")!;
    const { token } = mintInvite(forge.db, bob.id);
    expect(redeemInvite(forge.db, token, bob.id, Date.parse("2026-10-05T09:00:00Z"))).toBe(true);
    const h = boot("alice");
    await open(h);
    expect(h.text()).toContain("used by bob on 2026-10-05");
    h.stop();
  });
});
