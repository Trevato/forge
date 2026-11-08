/**
 * Cloud accounts at the terminal and MCP doors (#2199): a forge admin lists,
 * attaches, verifies, rotates, renames and removes through the functions the
 * page uses; anyone else is refused at both; no frame and no result carries a
 * token; a rename is refused when the secret name is taken even with no row.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addAccount, net, renameAccount } from "../src/actions/cloud.ts";
import { recordAudit } from "../src/core/cloud_audit.ts";
import { getCloudAccount, listCloudAccounts } from "../src/core/cloud_account.ts";
import { listSecretNames, resolveSecrets, setSecret } from "../src/core/secret_store.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { cloudScreen } from "../src/tui/screens/cloud.ts";
import { Session } from "../src/tui/session.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

const T1 = "ghp_first9Zq4TxLm7Kp2Vb8nWcR5";
const T2 = "ghp_second7Hs3DfGj6Lm1Qw0Zx8";
net.fetch = async (_url, init) => {
  const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "");
  return new Response(JSON.stringify({ login: "octo" }), {
    status: auth.includes(T1) || auth.includes(T2) ? 200 : 401,
  });
};

describe("cloud accounts at the terminal and MCP doors", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let adminToken = "";
  let rwToken = "";
  let bobToken = "";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-cloud-doors-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, adminIfFirst] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.test`, password: "a-good-passphrase", adminIfFirst });
      if (!made.ok) throw new Error(made.error);
    }
    alice = getUserByName(app.db, "alice")!;
    const bob = getUserByName(app.db, "bob")!;
    adminToken = createToken(app.db, alice.id, "admin", "admin").token;
    rwToken = createToken(app.db, alice.id, "rw", "rw").token;
    bobToken = createToken(app.db, bob.id, "admin", "admin").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mcp = async (token: string, name: string, args: unknown = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return { error: body.result.isError === true, text };
  };

  const boot = (username: string) => {
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal: headlessTerminal(160, 32), exitHooks: false });
    tui.start();
    const key = (k: string) => tui.dispatch({ type: "key", key: k, ctrl: false, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      press: async (...keys: string[]) => {
        keys.forEach(key);
        await settleApp(tui);
      },
      type: async (t: string) => {
        for (const ch of t) key(ch);
        await settleApp(tui);
      },
      paste: async (text: string) => {
        tui.dispatch({ type: "paste", text } as never);
        await settleApp(tui);
      },
      palette: async (q: string) => {
        tui.dispatch({ type: "key", key: "k", ctrl: true, alt: false, shift: false });
        await settleApp(tui);
        for (const ch of q) key(ch);
        await settleApp(tui);
      },
      stop: () => tui.stop(),
    };
  };

  test("terminal: an admin attaches, verifies, rotates, renames and removes, and no frame holds a token", async () => {
    const h = boot("alice");
    await h.palette("Cloud accounts");
    await h.press("enter");
    expect(h.text()).toContain("No account attached");

    await h.press("a");
    await h.type("github/main");
    await h.press("enter");
    await h.paste(`${T1}\n`); // a pasted token keeps its newline in a masked prompt; the action gets it trimmed, as from the page
    expect(h.text()).not.toContain(T1);
    await h.press("enter");
    expect(listCloudAccounts(app.db).map((a) => a.name)).toEqual(["main"]);
    const sealed = (name: string) => resolveSecrets(app.db, app.config.dataDir, app.bus, [name])[name];
    expect(sealed("CLOUD_GITHUB_MAIN")).toBe(T1);
    expect(listSecretNames(app.db, "forge").map((s) => s.name)).toEqual(["CLOUD_GITHUB_MAIN"]);
    expect(h.text()).toContain("github/main");
    expect(h.text()).toContain("1 call today");
    expect(h.text()).not.toContain(T1);

    await h.press("v");
    expect(h.text()).toContain("Verified github/main");
    // The attach made one gated vendor call, the verify one more, and this is a third.
    recordAudit(app.db, { provider: "github", account: "main", purpose: "verify", target: "https://api.github.com/user", bytesOut: 0, allowed: true });
    await h.press("j", "k");
    expect(h.text()).toContain("3 calls today");

    recordAudit(app.db, { provider: "github", account: "main", purpose: "audit", target: "https://api.github.com/orgs/blocked-here", bytesOut: 42, allowed: false });
    await h.press("c");
    expect(h.text()).toContain("https://api.github.com/user");
    expect(h.text()).toContain("https://api.github.com/orgs/blocked-here");
    expect(h.text()).toContain("REFUSED");
    expect(h.text()).toContain("42 B out");
    await h.press("esc");

    await h.press("r");
    await h.paste(` ${T2}\n`);
    expect(h.text()).not.toContain(T2);
    await h.press("enter");
    expect(h.text()).toContain("Rotated github/main");
    expect(sealed("CLOUD_GITHUB_MAIN")).toBe(T2);
    expect(h.text()).not.toContain(T2);

    await h.press("n");
    await h.type("work");
    await h.press("enter");
    expect(getCloudAccount(app.db, "github", "work")).toBeDefined();
    expect(getCloudAccount(app.db, "github", "main")).toBeUndefined();

    await h.press("x");
    await h.type("work");
    await h.press("enter");
    expect(listCloudAccounts(app.db)).toEqual([]);
    expect(listSecretNames(app.db, "forge")).toEqual([]);
    h.stop();
  });

  test("terminal: a non-admin has no command and, driving the screen, does nothing", async () => {
    const h = boot("bob");
    await h.palette("Cloud accounts");
    expect(h.text()).not.toContain("provider tokens");
    h.stop();

    const bob = getUserByName(app.db, "bob")!;
    const session = new Session(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user: bob });
    const pushed: unknown[] = [];
    const screen = cloudScreen(session, { push: (s: unknown) => pushed.push(s), invalidate() {} } as never);
    for (const k of ["a", "v", "r", "n", "x", "w", "A", "c"])
      screen.key?.({ type: "key", key: k, ctrl: false, alt: false, shift: false } as never);
    expect(pushed).toEqual([]);
  });

  test("MCP: an admin lists, attaches, verifies, rotates, renames and removes; no result holds a token", async () => {
    const attached = await mcp(adminToken, "cloud_account", { verb: "attach", provider: "github", name: "main", value: T1 });
    expect(attached.error).toBe(false);
    expect(attached.text).not.toContain(T1);
    const listed = await mcp(adminToken, "cloud_accounts");
    const value = JSON.parse(listed.text);
    expect(value.accounts).toHaveLength(1);
    expect(value.accounts[0]).toMatchObject({ provider: "github", name: "main", callsToday: value.today.length });
    expect(value.today.length).toBeGreaterThan(0);
    expect(value.today[0]).toMatchObject({ provider: "github", account: "main" });
    expect(listed.text).not.toContain(T1);

    for (const args of [
      { verb: "verify", provider: "github", name: "main" },
      { verb: "rotate", provider: "github", name: "main", value: T2 },
      { verb: "rename", provider: "github", name: "main", to: "work" },
    ]) {
      const r = await mcp(adminToken, "cloud_account", args);
      expect(r.error).toBe(false);
      expect(r.text).not.toContain(T1);
      expect(r.text).not.toContain(T2);
    }
    expect(getCloudAccount(app.db, "github", "work")).toBeDefined();
    expect((await mcp(adminToken, "cloud_account", { verb: "remove", provider: "github", name: "work" })).error).toBe(false);
    expect(listCloudAccounts(app.db)).toEqual([]);
  });

  test("MCP: a non-admin is refused, and a write-scope token cannot change accounts", async () => {
    for (const r of [
      await mcp(bobToken, "cloud_accounts"),
      await mcp(bobToken, "cloud_account", { verb: "attach", provider: "github", name: "main", value: T1 }),
    ]) {
      expect(r.error).toBe(true);
      expect(r.text).not.toContain(T1);
    }
    expect(listCloudAccounts(app.db)).toEqual([]);
    const weak = await mcp(rwToken, "cloud_account", { verb: "attach", provider: "github", name: "main", value: T1 });
    expect(weak.error).toBe(true);
    expect(listCloudAccounts(app.db)).toEqual([]);
  });

  test("terminal: an admin flips the write switch and audits into a repository", async () => {
    const made = await createRepo(app, alice, { name: "ops", visibility: "private" });
    if (!made.ok) throw new Error("repo");
    expect((await addAccount(app, alice, "github", "ledger", T1)).ok).toBe(true);
    const h = boot("alice");
    await h.palette("Cloud accounts");
    await h.press("enter");
    expect(h.text()).toContain("read-only");
    await h.press("w");
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(true);
    expect(h.text()).toContain("github/ledger: writes allowed.");
    await h.press("w");
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(false);
    expect(h.text()).toContain("github/ledger: read-only.");

    await h.press("A");
    await h.type("alice/nowhere");
    await h.press("enter");
    expect(h.text()).toContain("Name a repository");
    await h.press("A");
    await h.type("alice/ops");
    await h.press("enter");
    expect(h.text()).toContain("Audit: 0 issues opened");
    h.stop();
    await mcp(adminToken, "cloud_account", { verb: "remove", provider: "github", name: "ledger" });
  });

  test("MCP: an admin flips the write switch and audits; a non-admin cannot", async () => {
    expect((await addAccount(app, alice, "github", "ledger", T1)).ok).toBe(true);
    const on = await mcp(adminToken, "cloud_account", { verb: "allow_writes", provider: "github", name: "ledger", allowed: true });
    expect(on.error).toBe(false);
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(true);
    expect((await mcp(adminToken, "cloud_account", { verb: "allow_writes", provider: "github", name: "ledger" })).error).toBe(true);
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(true);
    expect((await mcp(adminToken, "cloud_account", { verb: "allow_writes", provider: "github", name: "ledger", allowed: false })).error).toBe(false);
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(false);

    const audited = await mcp(adminToken, "cloud_account", { verb: "audit", provider: "github", name: "ledger", repo: "alice/ops" });
    expect(audited.error).toBe(false);
    expect(audited.text).toContain("opened");
    expect((await mcp(adminToken, "cloud_account", { verb: "audit", provider: "github", name: "ledger", repo: "alice/nowhere" })).error).toBe(true);

    for (const args of [
      { verb: "allow_writes", provider: "github", name: "ledger", allowed: true },
      { verb: "audit", provider: "github", name: "ledger", repo: "alice/ops" },
    ])
      expect((await mcp(bobToken, "cloud_account", args)).error).toBe(true);
    expect(getCloudAccount(app.db, "github", "ledger")!.writeAllowed).toBe(false);
    await mcp(adminToken, "cloud_account", { verb: "remove", provider: "github", name: "ledger" });
  });

  test("a rename is refused when the secret exists, with no account row", async () => {
    expect((await addAccount(app, alice, "github", "main", T1)).ok).toBe(true);
    expect(setSecret(app.db, dataDir, "forge", "", "CLOUD_GITHUB_TAKEN", "an-unrelated-sealed-value").ok).toBe(true);
    expect(getCloudAccount(app.db, "github", "taken")).toBeUndefined();
    const r = renameAccount(app, alice, "github", "main", "taken");
    expect(r.ok).toBe(false);
    expect(getCloudAccount(app.db, "github", "main")).toBeDefined();
    expect(listSecretNames(app.db, "forge").map((s) => s.name)).toEqual(["CLOUD_GITHUB_MAIN", "CLOUD_GITHUB_TAKEN"]);
  });
});
