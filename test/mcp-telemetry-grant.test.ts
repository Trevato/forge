/** MCP `telemetry_grant`: the Telemetry page's grant, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listAt } from "./mcp-list.ts";

quietLogs();

const PASS = "a-long-telemetry-passphrase";

describe("MCP telemetry_grant", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let owner = "";
  let botToken = "";

  const call = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    // A tool the caller cannot see is a JSON-RPC error; one it can see and may not use is an isError result.
    if (body.error) return { error: true, text: body.error.message as string };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const grant = (token: string, agent: string, on: boolean) => call(token, "telemetry_grant", { agent, on });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-telgrant-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made: Record<string, any> = {};
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      made[username] = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made[username].ok) throw new Error(username);
    }
    owner = createToken(app.db, made["alice"].value.id, "t", "admin").token;
    const alice = getUserByName(app.db, "alice")!;
    const bot = await createAgent(app, alice, { username: "bot" });
    if (!bot.ok) throw new Error("bot");
    botToken = createToken(app.db, bot.value.user.id, "t", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner grants an agent, whose telemetry read then succeeds; taking it back fails it again", async () => {
    expect((await call(botToken, "system", {})).error).toBe(true);
    const on = await grant(owner, "bot", true);
    expect(on.error).toBe(false);
    expect(JSON.parse(on.text)).toEqual({ agent: "bot", on: true, says: "bot may now read telemetry." });
    expect((await call(botToken, "system", {})).error).toBe(false);
    const off = await grant(owner, "bot", false);
    expect(JSON.parse(off.text)).toEqual({ agent: "bot", on: false, says: "bot no longer reads telemetry." });
    expect((await call(botToken, "system", {})).error).toBe(true);
  });

  test("a person's name is refused", async () => {
    const r = await grant(owner, "bob", true);
    expect(r.error).toBe(true);
    expect(r.text).toContain("Only an agent account can be granted telemetry:read.");
  });

  const list = async (token: string) => {
    return (await listAt(servers.url, token)).result.tools.map((t: any) => t.name) as string[];
  };

  test("only an admin-scope token is listed the tool", async () => {
    expect(await list(owner)).toContain("telemetry_grant");
    expect(await list(botToken)).not.toContain("telemetry_grant");
  });

  test("the owner with a rw or ro token is not listed the tool and is refused", async () => {
    const alice = getUserByName(app.db, "alice")!;
    for (const scope of ["rw", "ro"] as const) {
      const tok = createToken(app.db, alice.id, "t", scope).token;
      expect(await list(tok)).not.toContain("telemetry_grant");
      expect((await grant(tok, "bot", true)).error).toBe(true);
    }
    expect((await call(botToken, "system", {})).error).toBe(true);
  });

  test("an unknown name is not found", async () => {
    const r = await grant(owner, "nobody", true);
    expect(r.error).toBe(true);
    expect(r.text).toContain("no such account");
  });

  test("a non-owner is refused", async () => {
    const bobTok = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "admin").token;
    expect((await grant(bobTok, "bot", true)).error).toBe(true);
    expect((await grant(botToken, "bot", true)).error).toBe(true);
    expect((await call(botToken, "system", {})).error).toBe(true);
  });
});
