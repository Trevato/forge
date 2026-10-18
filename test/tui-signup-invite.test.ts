/**
 * With signup = invite the terminal's create-account screen asks for the
 * invite token and redeems it as the web form does: a good token makes the
 * account and is spent; a bad one gets one plain refusal and makes none.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { listInvites, mintInvite } from "../src/core/invites.ts";
import { getUserByName } from "../src/core/users.ts";
import { setSignup } from "../src/settings/signup.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { fixtureSlot } from "./helpers/slot.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";

describe("terminal sign-up with an invite", () => {
  let dir: string;
  let forge: Forge;
  let adminId: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-tui-invite-signup-"));
    forge = createApp({ dataDir: dir, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
    const admin = await signUp(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" }, { slot: fixtureSlot(forge) });
    if (!admin.ok) throw new Error(admin.error);
    adminId = admin.value.id;
    setSignup(forge.db, "invite", adminId);
  });
  afterAll(async () => {
    forge.close();
    await rm(dir, { recursive: true, force: true });
  });

  const attempt = async (name: string, token: string): Promise<string> => {
    const identity: TuiIdentity = { sshUsername: "git", remoteAddress: "198.51.100.7", fingerprint: "SHA256:x", publicKey: KEY };
    const { app } = createForgeApp(forge, identity, { terminal: headlessTerminal(120, 32), exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false): void =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    const type = (t: string): void => [...t].forEach((c) => key(c));
    try {
      await settleApp(app);
      key("s");
      await settleApp(app);
      key("t", true);
      await settleApp(app);
      expect(app.screen.toText()).toContain("Invite");
      type(name);
      key("tab");
      type(`${name}@forge.test`);
      key("tab");
      type("a-long-passphrase");
      key("tab");
      type(token);
      key("enter");
      await settleApp(app);
      return app.screen.toText();
    } finally {
      app.stop();
    }
  };

  test("a bad token gets one plain refusal and makes no account", async () => {
    const text = await attempt("mallory", "invite_nope");
    expect(text).toContain("This invite link has been used, revoked or has expired.");
    expect(text).not.toContain("Signup is closed");
    expect(getUserByName(forge.db, "mallory")).toBeFalsy();
  });

  test("a blank token is asked for, not called spent", async () => {
    const text = await attempt("blanca", "");
    expect(text).toContain("Paste the token from your invite link.");
    expect(text).not.toContain("used, revoked");
    expect(getUserByName(forge.db, "blanca")).toBeFalsy();
  });

  test("the screen follows the live setting", async () => {
    const identity: TuiIdentity = { sshUsername: "git", remoteAddress: "198.51.100.8", fingerprint: "SHA256:y", publicKey: KEY };
    const { app } = createForgeApp(forge, identity, { terminal: headlessTerminal(120, 32), exitHooks: false });
    app.start();
    const key = (k: string, ctrl = false): void =>
      app.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    try {
      await settleApp(app);
      key("s");
      await settleApp(app);
      key("t", true);
      await settleApp(app);
      expect(app.screen.toText()).toContain("Invite");
      setSignup(forge.db, "open", adminId);
      key("x");
      await settleApp(app);
      expect(app.screen.toText()).not.toContain("Invite");
    } finally {
      app.stop();
      setSignup(forge.db, "invite", adminId);
    }
  });

  test("a good token makes the account and is spent; reusing it is refused", async () => {
    const { token } = mintInvite(forge.db, adminId);
    await attempt("dana", token);
    expect(getUserByName(forge.db, "dana")).toBeTruthy();
    expect(listInvites(forge.db).every((i) => i.state === "used")).toBe(true);
    await attempt("eve", token);
    expect(getUserByName(forge.db, "eve")).toBeFalsy();
  });
});
