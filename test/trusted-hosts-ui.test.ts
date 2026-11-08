/** The trusted-host list's two doors (page, terminal) and the migrate path (#3290). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { resolveSource } from "../src/actions/migrate.ts";
import { createOrigin } from "../src/core/origins.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { loadTrustedHosts, parseHosts, rejectedSentence, trustedHosts } from "../src/origins/trusted-hosts.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import type { TuiIdentity } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("trusted internal hosts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;

  const login = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const post = (cookie: string, hosts: string, origin = servers.url) =>
    fetch(`${servers.url}/settings/origins/trusted-hosts`, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded", origin },
      body: new URLSearchParams({ hosts }),
    });
  const changes = () =>
    app.db
      .query<{ to_value: string }, []>(
        "SELECT to_value FROM forge_setting_change WHERE key = 'outbound.trusted_hosts' ORDER BY rowid",
      )
      .all()
      .map((r) => r.to_value);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-trusted-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
    }
    loadTrustedHosts(app.db, {});
  });
  afterAll(async () => {
    loadTrustedHosts(undefined, {});
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("parseHosts names what it refuses", () => {
    expect(parseHosts("a.test 10.0.0.1 *.b.test https://c.test")).toEqual({
      hosts: ["a.test"],
      rejected: ["10.0.0.1", "*.b.test", "https://c.test"],
    });
  });

  test("a non-admin gets 403, sees no card, and nothing changes", async () => {
    const bob = await login("bob");
    expect((await post(bob, "git.internal.test")).status).toBe(403);
    expect(trustedHosts()).toEqual([]);
    const page = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie: bob } })).text();
    expect(page).not.toContain("Trusted internal hosts");
  });

  test("a cross-origin post is refused", async () => {
    const alice = await login("alice");
    const res = await post(alice, "git.internal.test", "https://evil.test");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(trustedHosts()).toEqual([]);
  });

  test("entries that are not names are refused aloud and nothing is saved", async () => {
    const alice = await login("alice");
    const res = await post(alice, "git.internal.test 10.0.0.1");
    expect(res.status).toBe(422);
    const text = await res.text();
    expect(text).toContain("Not host names");
    expect(text).toContain("10.0.0.1");
    expect(trustedHosts()).toEqual([]);
    expect(changes()).toEqual([]);
  });

  test("an admin save is live, audited, shown, and marks the origin row", async () => {
    const alice = await login("alice");
    const res = await post(alice, "git.internal.test");
    expect(res.status).toBe(303);
    expect(trustedHosts()).toEqual(["git.internal.test"]);
    expect(changes()).toEqual(['["git.internal.test"]']);

    const user = getUserByName(app.db, "alice")!;
    for (const [login, host] of [["me", "git.internal.test"], ["you", "other.test"]] as const) {
      const made = createOrigin(app.db, dataDir, {
        userId: user.id,
        kind: "forgejo",
        apiUrl: `https://${host}/api/v1`,
        webUrl: `https://${host}`,
        login,
        token: "t0ken",
      });
      expect(made.ok).toBe(true);
    }
    const page = await (await fetch(`${servers.url}/settings/origins`, { headers: { cookie: alice } })).text();
    expect(page).toContain("Trusted internal hosts");
    expect(page).toContain("git.internal.test");
    expect(page.match(/trusted internal host/g)?.length).toBe(1);
  });

  test("migrate lets a non-admin reach a trusted host that resolves privately, not an untrusted one", async () => {
    const bob = getUserByName(app.db, "bob")!;
    const resolve = async () => ["10.43.191.15"];
    const trusted = await resolveSource(app, bob, { url: "https://git.internal.test/a/b.git" }, resolve);
    expect(trusted.ok).toBe(true);
    const other = await resolveSource(app, bob, { url: "https://nope.test/a/b.git" }, resolve);
    expect(other).toEqual({ ok: false, error: "private_host" });
  });

  describe("in the terminal", () => {
    function boot(username: string) {
      const terminal = headlessTerminal(140, 32);
      const user = getUserByName(app.db, username)!;
      const identity: TuiIdentity = { sshUsername: "t", remoteAddress: "127.0.0.1", user };
      const { app: tui } = createForgeApp(app, identity, { terminal, exitHooks: false });
      tui.start();
      const key = (k: string, ctrl = false) =>
        tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      return {
        text: () => tui.screen.toText(),
        async palette() {
          key("k", true);
          for (const ch of "Trusted hosts") key(ch);
          await settleApp(tui);
        },
        async type(text: string) {
          for (const ch of text) key(ch);
          await settleApp(tui);
        },
        async enter() {
          key("enter");
          await settleApp(tui);
        },
        stop: () => tui.stop(),
      };
    }

    test("a non-admin is not offered it", async () => {
      const before = changes();
      const h = boot("bob");
      await h.palette();
      expect(h.text()).not.toContain("internal hosts an origin may reach");
      expect(trustedHosts()).toEqual(["git.internal.test"]);
      expect(changes()).toEqual(before);
      h.stop();
    });

    test("an admin reads and saves the list through the same door", async () => {
      const h = boot("alice");
      await h.palette();
      expect(h.text()).toContain("internal hosts an origin may reach");
      await h.enter();
      expect(h.text()).toContain("git.internal.test");
      await h.type(" 10.1.1.1");
      await h.enter();
      expect(h.text()).toContain(rejectedSentence(parseHosts("10.1.1.1").rejected).slice(0, 40));
      expect(trustedHosts()).toEqual(["git.internal.test"]);
      h.stop();
    });

    test("an admin saves from the terminal: live and audited", async () => {
      const before = changes().length;
      const h = boot("alice");
      await h.palette();
      await h.enter();
      await h.type(" second.test");
      await h.enter();
      expect(trustedHosts().sort()).toEqual(["git.internal.test", "second.test"]);
      expect(changes().at(-1)).toBe('["git.internal.test","second.test"]');
      expect(changes()).toHaveLength(before + 1);
      expect(h.text()).toContain("Trusted: git.internal.test, second.test.");
      h.stop();
    });
  });
});
