/** MCP `flag_set`: the Flags page's write, from a harness, under its rules. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const reg = makeFlags({ alpha: { why: "shows the new board", default: false, issue: 1 } });

describe("MCP flag_set", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let bob = "";
  let aliceRw = "";
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id++,
        method: "tools/call",
        params: { name: "flag_set", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true };
  };

  const page = async (): Promise<string> => {
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return (await fetch(`${servers.url}/settings/flags`, { headers: { cookie } })).text();
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flag-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed",
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        trusted: true,
        adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice", true);
    const b = await mk("bob", false);
    admin = createToken(app.db, a.id, "admin", "admin").token;
    aliceRw = createToken(app.db, a.id, "rw", "rw").token;
    bob = createToken(app.db, b.id, "admin", "admin").token;
    useFlagRegistry(reg);
  });
  afterAll(async () => {
    useFlagRegistry(undefined);
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets a declared flag and the registry meets it", async () => {
    const r = await call(admin, { name: "alpha", value: { forge: true, percent: 30 } });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ name: "alpha", value: { forge: true, percent: 30 }, says: "alpha: saved." });
    expect(reg.value("alpha")).toEqual({ forge: true, percent: 30 });
    const html = await page();
    expect(html).toContain('<option value="on" selected');
    expect(html).toContain('aria-label="alpha percent"');
    expect(html).toMatch(/value="30"[^>]*aria-label="alpha percent"/);
  });

  test("clear returns it to its default", async () => {
    const r = await call(admin, { name: "alpha", clear: true });
    expect(JSON.parse(r.text)).toEqual({ name: "alpha", value: null, says: "alpha: cleared." });
    expect(reg.value("alpha")).toBeUndefined();
  });

  test("an unknown flag and a bad value are refused", async () => {
    const unknown = await call(admin, { name: "nope", value: { forge: true } });
    expect(unknown.error).toBe(true);
    expect(unknown.text).toContain("There is no such flag.");
    const bad = await call(admin, { name: "alpha", value: { percent: 101 } });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain("percent is a whole number from 0 to 100.");
    expect(reg.value("alpha")).toBeUndefined();
    for (const value of [{ users: [42] }, { users: ["a,b"] }, { roles: "admin" }, { percent: "5" }, { fore: true }]) {
      const r = await call(admin, { name: "alpha", value });
      expect(r.error).toBe(true);
      expect(r.text).toContain("value is {");
    }
    expect(reg.value("alpha")).toBeUndefined();
  });

  test("a non-admin is refused in the page's words", async () => {
    const r = await call(bob, { name: "alpha", value: { forge: true } });
    expect(r.error).toBe(true);
    expect(r.text).toContain("Flags are set by a forge admin.");
    const junk = await call(bob, { name: 7, value: 3 });
    expect(junk.text).toContain("Flags are set by a forge admin.");
    expect(reg.value("alpha")).toBeUndefined();
  });

  test("an admin's non-admin-scope token is refused and nothing changes", async () => {
    const r = await call(aliceRw, { name: "alpha", value: { forge: true } });
    expect(r.error).toBe(true);
    expect(r.text).toContain("setting a flag needs an admin token");
    expect(reg.value("alpha")).toBeUndefined();
  });
});
