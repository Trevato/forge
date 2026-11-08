/** Roles, part 1 (#2301): read from the data, shown on one page, promoted in one action; nothing refused. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getModelGrant } from "../src/core/model_grant.ts";
import { ABILITIES, CAN, ROLES, can, roleOf, rolesTable, setMember } from "../src/core/roles.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createToken } from "../src/core/tokens.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-roles-passphrase";

describe("the table", () => {
  test("docs/ROLES.md repeats CAN exactly", async () => {
    const doc = await readFile(join(import.meta.dir, "../docs/ROLES.md"), "utf8");
    const m = doc.match(/<!-- roles-table -->\n([\s\S]*?)\n<!-- \/roles-table -->/);
    expect(m?.[1]).toBe(rolesTable());
  });

  test("every role is in the table, and each ability is known", () => {
    expect(Object.keys(CAN).sort()).toEqual([...ROLES].sort());
    for (const r of ROLES) for (const a of CAN[r]) expect(a in ABILITIES).toBe(true);
    expect(can("guest", "make_it_yours")).toBe(false);
    expect(can("member", "make_it_yours")).toBe(true);
    expect(can("member", "administer")).toBe(false);
  });
});

describe("roles on /settings/people", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const signIn = async (username: string) => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASS }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };
  const post = (cookie: string, user: string, body: Record<string, string>, origin = servers.url) =>
    fetch(`${servers.url}/settings/people/${user}/role`, {
      method: "POST",
      headers: { cookie, origin },
      body: new URLSearchParams(body),
      redirect: "manual",
    });
  const roleNow = (name: string) => roleOf(app.db, getUserByName(app.db, name)!);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-roles-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("roles are read: admin from the flag, member from the table, else guest", () => {
    expect(roleNow("alice")).toBe("admin");
    expect(roleNow("bob")).toBe("guest");
  });

  test("the page lists everyone with a role, for an admin only", async () => {
    const alice = await signIn("alice");
    const html = await (await fetch(`${servers.url}/settings/people`, { headers: { cookie: alice } })).text();
    expect(html).toContain("alice");
    expect(html).toContain("bob");
    expect(html).toContain("Make member");
    const bob = await signIn("bob");
    expect((await fetch(`${servers.url}/settings/people`, { headers: { cookie: bob } })).status).toBe(404);
  });

  test("the account page shows the caller's own row of the table", async () => {
    const page = async (c: string) => (await fetch(`${servers.url}/settings`, { headers: { cookie: c } })).text();
    const bob = await page(await signIn("bob"));
    expect(bob).toContain("What you can do here");
    expect(bob).toMatch(/Administer the forge: <strong>no<\/strong>/);
    setMember(app.db, (getUserByName(app.db, "bob"))!.id, true, "x", new Date());
    const member = await page(await signIn("bob"));
    expect(member).toMatch(/Create a repository or copy an app: <strong>yes<\/strong>/);
    expect(member).toMatch(/Administer the forge: <strong>no<\/strong>/);
    setMember(app.db, getUserByName(app.db, "bob")!.id, false, "x", new Date());
    const alice = await page(await signIn("alice"));
    expect(alice).toMatch(/Administer the forge: <strong>yes<\/strong>/);
  });

  test("a guest is promoted with no allowance by default, and demoted", async () => {
    const alice = await signIn("alice");
    expect((await post(alice, "bob", { role: "member" })).status).toBe(303);
    expect(roleNow("bob")).toBe("member");
    expect(getModelGrant(app.db, getUserByName(app.db, "bob")!.id)).toBeUndefined();
    const ev = app.db.query<{ payload: string }, []>("SELECT payload FROM event WHERE kind = 'account.role_set' ORDER BY id DESC LIMIT 1").get();
    expect(JSON.parse(ev!.payload)).toMatchObject({ username: "bob", role: "member" });
    await post(alice, "bob", { role: "guest" });
    expect(roleNow("bob")).toBe("guest");
  });

  test("a starter allowance goes through the model grant; a bad one changes nothing", async () => {
    const alice = await signIn("alice");
    await post(alice, "carol", { role: "member", usd: "nonsense" });
    expect(roleNow("carol")).toBe("guest");
    await post(alice, "carol", { role: "member", usd: "5" });
    expect(roleNow("carol")).toBe("member");
    expect(getModelGrant(app.db, getUserByName(app.db, "carol")!.id)?.usdPerMonth).toBe(5);
  });

  test("a non-admin, a foreign origin, an admin target and an unknown role are refused", async () => {
    const bob = await signIn("bob");
    expect((await post(bob, "bob", { role: "member" })).status).toBe(404);
    expect(roleNow("bob")).toBe("guest");
    const alice = await signIn("alice");
    expect((await post(alice, "bob", { role: "member" }, "https://evil.example")).status).toBeGreaterThanOrEqual(400);
    expect(roleNow("bob")).toBe("guest");
    await post(alice, "alice", { role: "guest" });
    expect(roleNow("alice")).toBe("admin");
    expect((await post(alice, "bob", { role: "admin" })).status).toBe(404);
    expect(roleNow("bob")).toBe("guest");
  });

  test("a starter allowance is audited as a model grant", () => {
    const ev = app.db
      .query<{ payload: string; actor_id: string }, []>("SELECT payload, actor_id FROM event WHERE kind = 'account.model_granted' ORDER BY id DESC LIMIT 1")
      .get();
    expect(JSON.parse(ev!.payload)).toEqual({ username: "carol", usdPerMonth: 5 });
    expect(ev!.actor_id).toBe(getUserByName(app.db, "alice")!.id);
  });

  test("the API lists people and sets a role for an admin token only", async () => {
    const tok = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "admin").token;
    const bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin").token;
    const send = (token: string, role: unknown, usd?: unknown) =>
      fetch(`${servers.url}/api/v1/admin/accounts/bob/role`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ role, usdPerMonth: usd }),
      });
    expect((await send(bobTok, "member")).status).toBe(403);
    expect((await send(tok, "admin")).status).toBe(422);
    expect((await send(tok, "member", -1)).status).toBe(422);
    expect(roleNow("bob")).toBe("guest");
    const ok = await send(tok, "member", 3);
    expect(await ok.json()).toEqual({ username: "bob", role: "member", usdPerMonth: 3 });
    const list = await fetch(`${servers.url}/api/v1/admin/people`, { headers: { authorization: `Bearer ${tok}` } });
    const people = ((await list.json()) as any).items as { username: string; role: string }[];
    expect(people.find((p) => p.username === "bob")?.role).toBe("member");
    expect(people.find((p) => p.username === "alice")?.role).toBe("admin");
    expect((await send(tok, "guest")).status).toBe(200);
    expect(roleNow("bob")).toBe("guest");
  });

  test("MCP account_role plans by default and sets with dryRun false, for an admin token", async () => {
    const mcp = async (token: string, args: unknown) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_role", arguments: args } }),
      });
      const body = (await res.json()) as any;
      return { error: body.result.isError === true, text: body.result.content[0].text as string };
    };
    const tok = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "admin").token;
    const rw = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "rw").token;
    const bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin").token;
    expect((await mcp(tok, { username: "bob", role: "member" })).text).toContain("nothing changed");
    expect(roleNow("bob")).toBe("guest");
    expect((await mcp(rw, { username: "bob", role: "member", dryRun: false })).error).toBe(true);
    expect((await mcp(bobTok, { username: "bob", role: "member", dryRun: false })).error).toBe(true);
    expect((await mcp(tok, { username: "bob", role: "boss", dryRun: false })).error).toBe(true);
    expect(roleNow("bob")).toBe("guest");
    expect((await mcp(tok, { username: "bob", role: "member", dryRun: false })).error).toBe(false);
    expect(roleNow("bob")).toBe("member");
    await mcp(tok, { username: "bob", role: "guest", dryRun: false });
  });

  test("the terminal lists people and changes a role; a person has no such command", async () => {
    const boot = (username: string) => {
      const terminal = headlessTerminal(140, 32);
      const user = getUserByName(app.db, username)!;
      const { app: tui } = createForgeApp(app, { sshUsername: "t", remoteAddress: "127.0.0.1", user }, { terminal, exitHooks: false });
      tui.start();
      const key = (k: string, ctrl = false) => tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      return {
        text: () => tui.screen.toText(),
        press: async (...ks: string[]) => { ks.forEach((k) => key(k)); await settleApp(tui); },
        palette: async (title: string) => { key("k", true); await settleApp(tui); for (const ch of title) key(ch); await settleApp(tui); },
        type: async (t: string) => { for (const ch of t) key(ch); await settleApp(tui); },
        stop: () => tui.stop(),
      };
    };
    const h = boot("alice");
    await h.palette("People");
    await h.press("enter");
    expect(h.text()).toContain("bob  guest");
    await h.press("r");
    await h.type("bob");
    await h.press("enter");
    await h.type("member 4");
    await h.press("enter");
    expect(roleNow("bob")).toBe("member");
    expect(getModelGrant(app.db, getUserByName(app.db, "bob")!.id)?.usdPerMonth).toBe(4);
    h.stop();
    const p = boot("bob");
    await p.palette("People");
    expect(p.text()).not.toContain("promote or demote");
    p.stop();
  });
});
