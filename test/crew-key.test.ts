/**
 * The owner's model key (#11154), at both doors: the page's POST
 * /settings/crew/key (admin only, same-origin, bounded) and the terminal's
 * Crew key screen, both through `saveCrewKey`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keyShapeOk, saveCrewKey, KEY_MAX_BYTES } from "../src/actions/crew_key.ts";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { listGrants, listSubscriptions } from "../src/core/subscriptions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp, settleUntil } from "./helpers/tui.ts";

quietLogs();

const GOOD = "sk-ant-api03-abcdefghijklmnop";

describe("adding the crew's key", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let plain = "";
  const post = (cookie: string | undefined, token: string, headers: Record<string, string> = {}) =>
    fetch(`${servers.url}/settings/crew/key`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url, ...(cookie ? { cookie } : {}), ...headers },
      body: new URLSearchParams({ token }),
    });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-crew-key-"));
    app = createApp({ dataDir: dir, port: 0 });
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-starter-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    admin = `forge_session=${createSession(app.db, getUserByName(app.db, "alice")!.id).token}`;
    plain = `forge_session=${createSession(app.db, getUserByName(app.db, "bob")!.id).token}`;
    servers = await serve(app);
  });
  afterAll(async () => {
    servers?.stop();
    app?.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("a signed-out caller is sent to sign in, and nothing is saved", async () => {
    const res = await post(undefined, GOOD);
    expect([302, 303]).toContain(res.status);
    expect(res.headers.get("location") ?? "").toContain("/signin");
    expect(listSubscriptions(app.db)).toEqual([]);
  });

  test("a non-admin gets the 403 page", async () => {
    expect((await post(plain, GOOD)).status).toBe(403);
    expect(listSubscriptions(app.db)).toEqual([]);
  });

  test("a cross-origin POST is refused", async () => {
    const res = await post(admin, GOOD, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(listSubscriptions(app.db)).toEqual([]);
  });

  test("a key with a control character or over the byte cap is refused before it is sealed", async () => {
    expect(keyShapeOk("sk-ant-api03-ab\ncd")).toBe(false);
    expect(keyShapeOk("sk-ant-api03-ab\u0000cd")).toBe(false);
    expect(keyShapeOk("é".repeat(KEY_MAX_BYTES / 2 + 1))).toBe(false);
    expect(keyShapeOk(GOOD)).toBe(true);
    const res = await post(admin, `sk-ant-api03-ab\u0007cd`);
    expect(res.status).toBe(303);
    expect(listSubscriptions(app.db)).toEqual([]);
    const flashed = await (await fetch(`${servers.url}/`, { headers: { cookie: `${admin}; ${(res.headers.getSetCookie()[0] ?? "").split(";")[0]}` } })).text();
    expect(flashed).toContain("That key could not be saved");
  });

  test("a bad key flashes the error and saves nothing", async () => {
    const res = await post(admin, "   ");
    expect(res.status).toBe(303);
    expect(listSubscriptions(app.db)).toEqual([]);
  });

  test("a good key is sealed and granted to the admin; the page never echoes it", async () => {
    const res = await post(admin, GOOD);
    expect(res.status).toBe(303);
    const subs = listSubscriptions(app.db);
    expect(subs.map((s) => s.name)).toEqual(["my-key"]);
    expect(listGrants(app.db, getUserByName(app.db, "alice")!.id).map((g) => g.subscriptionId)).toEqual([subs[0]!.id]);
    const home = await (await fetch(`${servers.url}/`, { headers: { cookie: admin } })).text();
    expect(home).not.toContain(GOOD);
  });

  test("a person who is not an admin is refused by the action itself", async () => {
    expect(await saveCrewKey(app, getUserByName(app.db, "bob")!, GOOD)).toEqual({ ok: false, error: "not_found" });
  });
});

describe("the terminal door", () => {
  test("Crew key is offered to an admin, takes a masked key, and is not offered to anyone else", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-tui-crewkey-"));
    const forge = createApp({ dataDir, port: 0 });
    try {
      for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
        const made = await createUser(forge.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-starter-passphrase", adminIfFirst });
        if (!made.ok) throw new Error(made.error);
      }
      const boot = (username: string) => {
        const terminal = headlessTerminal(140, 32);
        const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user: getUserByName(forge.db, username)! };
        const { app } = createForgeApp(forge, identity, { terminal, exitHooks: false });
        app.start();
        const key = (k: string) => app.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
        return {
          app,
          open: async () => {
            app.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
            await settleApp(app);
            for (const ch of "Crew key") key(ch);
            await settleApp(app);
          },
          type: async (t: string) => {
            for (const ch of t) key(ch);
            await settleApp(app);
          },
          press: async (k: string) => {
            key(k);
            await settleApp(app);
          },
        };
      };
      const bob = boot("bob");
      await bob.open();
      expect(bob.app.screen.toText()).not.toContain("what the crew runs on");
      bob.app.stop();

      const h = boot("alice");
      await h.open();
      await settleUntil(h.app, "what the crew runs on", { timeoutMs: 4_000 });
      await h.press("enter");
      await settleUntil(h.app, "The crew needs a model key to start", { timeoutMs: 4_000 });
      await h.press("a");
      await settleUntil(h.app, "Your model key", { timeoutMs: 4_000 });
      await h.type(GOOD);
      expect(h.app.screen.toText()).not.toContain("abcdefghijklmnop");
      await h.press("enter");
      await settleUntil(h.app, "Key saved", { timeoutMs: 4_000 });
      expect(listSubscriptions(forge.db).map((s) => s.name)).toEqual(["my-key"]);
      h.app.stop();
    } finally {
      forge.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
