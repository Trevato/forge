/**
 * The terminal's create-account screen draws on the same signup windows as
 * the other doors, keyed on the SSH peer's bucket: past signup.per_source it
 * shows when to try again and makes no user.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signUp } from "../src/actions/users.ts";
import { createApp, type App as Forge } from "../src/app.ts";
import { notePeer } from "../src/http/peer.ts";
import { getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { signupAllowed } from "../src/web/pages/site.ts";
import type { Ctx } from "../src/http/context.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2S7bF0R4NmuTUvVJXPPjdI1AF8XHXeYSNfr8DJ5eDo terminal-test";

describe("terminal sign-up throttle", () => {
  let dir: string;
  let forge: Forge;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-tui-signup-"));
    forge = createApp({ dataDir: dir, port: 0, disk: () => ({ freeBytes: 95, totalBytes: 100 }) });
    const admin = await signUp(forge, { username: "alice", email: "alice@forge.test", password: "a-long-passphrase" });
    expect(admin).toMatchObject({ ok: true });
  });
  afterAll(async () => {
    forge.close();
    await rm(dir, { recursive: true, force: true });
  });

  const attempt = async (address: string, name: string): Promise<string> => {
    const identity: TuiIdentity = { sshUsername: "git", remoteAddress: address, fingerprint: "SHA256:x", publicKey: KEY };
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
      type(name);
      key("tab");
      type(`${name}@forge.test`);
      key("tab");
      type("a-long-passphrase");
      key("enter");
      await settleApp(app);
      return app.screen.toText();
    } finally {
      app.stop();
    }
  };

  test("past signup.per_source a terminal sign-up is refused with a wait and makes no user; an API-side call from that source shares the window", async () => {
    const address = "203.0.113.50";
    // Four sign-ups from this source through the shared window...
    for (let i = 0; i < 4; i++) {
      const request = new Request("http://forge.local/api/v1/users");
      notePeer(request, address);
      expect(signupAllowed({ app: forge, request } as unknown as Ctx)).toBeUndefined();
    }
    // ...the terminal gets the fifth...
    await attempt(address, "fifth");
    expect(getUserByName(forge.db, "fifth")).toBeTruthy();
    // ...and the sixth is refused, with when to try again.
    const text = await attempt(address, "sixth");
    expect(text).toMatch(/Try again in \d+ seconds/);
    expect(getUserByName(forge.db, "sixth")).toBeFalsy();
    // The same source, by the web's door, is refused too.
    const request = new Request("http://forge.local/signup");
    notePeer(request, address);
    expect(signupAllowed({ app: forge, request } as unknown as Ctx)).toBeGreaterThan(0);
    // Another source is untouched.
    await attempt("203.0.113.51", "other");
    expect(getUserByName(forge.db, "other")).toBeTruthy();
  });
});
