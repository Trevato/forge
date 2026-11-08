/** MCP `sessions`: the sign-ins API, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { visible } from "../src/http/mcp/shared.ts";
import { TOOLS } from "../src/http/mcp/tools.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP sessions", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  const id = (name: string) => getUserByName(app.db, name)!.id;
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sessions", arguments: args } }),
    });
    const body = (await res.json()) as any;
    if (body.error !== undefined) return { error: true, text: String(body.error.message) };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-sessions-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-sessions-passphrase", isAdmin });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person with two sign-ins sees both, and no secret", async () => {
    const a = createSession(app.db, id("bob")).token;
    const b = createSession(app.db, id("bob")).token;
    const tok = createToken(app.db, id("bob"), "t", "admin").token;
    const got = await mcp(tok, {});
    expect(got.error).toBe(false);
    const out = JSON.parse(got.text);
    expect(out.sessions).toHaveLength(2);
    expect(out.says).toContain("bob");
    for (const secret of [a, b, tok]) expect(got.text).not.toContain(secret);
  });

  test("a stranger naming another person is refused as the route refuses", async () => {
    const tok = createToken(app.db, id("carol"), "t", "admin").token;
    const got = await mcp(tok, { username: "bob" });
    expect(got.error).toBe(true);
    expect(got.text).toContain("not_found");
    const route = await fetch(`${servers.url}/api/v1/users/bob/signins`, { headers: { authorization: `Bearer ${tok}` } });
    expect(route.status).toBe(404);
  });

  test("the owner sees a person's; a token below admin scope is refused", async () => {
    const owner = createToken(app.db, id("alice"), "t", "admin").token;
    expect(JSON.parse((await mcp(owner, { username: "bob" })).text).sessions).toHaveLength(2);
    const rw = createToken(app.db, id("bob"), "t2", "rw").token;
    // tools/list is cut to a byte budget, so the manifest's rule is asserted on `visible` itself.
    const tool = TOOLS.find((t) => t.name === "sessions")!;
    const user = getUserByName(app.db, "bob")!;
    expect(visible(tool, { auth: { scope: "rw" } } as any, user)).toBe(false);
    expect(visible(tool, { auth: { scope: "admin" } } as any, user)).toBe(true);
    const list = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${rw}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const names = ((await list.json()) as any).result.tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("sessions");
    expect((await mcp(rw, {})).error).toBe(true);
  });

  const me = async (cookie: string) => (await fetch(`${servers.url}/api/v1/user`, { headers: { cookie: `forge_session=${cookie}` } })).status;

  test("end signs one browser out, and its cookie answers as signed out", async () => {
    const lost = createSession(app.db, id("carol")).token;
    const tok = createToken(app.db, id("carol"), "t", "admin").token;
    expect(await me(lost)).toBe(200);
    const list = JSON.parse((await mcp(tok, {})).text).sessions as { id: string }[];
    const got = await mcp(tok, { action: "end", id: list[list.length - 1]!.id });
    expect(got.error).toBe(false);
    expect(JSON.parse(got.text).says).toContain("signed out");
    expect(await me(lost)).toBe(401);
  });

  test("ending your own says it may be the browser you are in; an owner ending another's names them", async () => {
    const tok = createToken(app.db, id("carol"), "t", "admin").token;
    const own = createSession(app.db, id("carol"));
    const sid = (JSON.parse((await mcp(tok, {})).text).sessions as { id: string }[]).at(-1)!.id;
    expect(JSON.parse((await mcp(tok, { action: "end", id: sid })).text).says).toContain("if it is the one you are in now");
    const bobsId = (JSON.parse((await mcp(createToken(app.db, id("alice"), "t", "admin").token, { username: "bob" })).text).sessions as { id: string }[])[0]!.id;
    const owner = createToken(app.db, id("alice"), "t", "admin").token;
    expect(JSON.parse((await mcp(owner, { username: "bob", action: "end", id: bobsId })).text).says).toContain("out of bob");
    expect(own.token).toBeTruthy();
  });

  test("an unknown id, or another person's session, is refused as the route refuses", async () => {
    const tok = createToken(app.db, id("carol"), "t", "admin").token;
    const bobs = (JSON.parse((await mcp(createToken(app.db, id("bob"), "t", "admin").token, {})).text).sessions as { id: string }[])[0]!.id;
    for (const [args, route] of [[{ action: "end", id: "nope" }, "nope"], [{ action: "end", id: bobs }, bobs]] as const) {
      const got = await mcp(tok, args);
      expect(got.error).toBe(true);
      expect(got.text).toContain("not_found");
      const res = await fetch(`${servers.url}/api/v1/users/carol/sessions/${route}`, { method: "DELETE", headers: { authorization: `Bearer ${tok}` } });
      expect(res.status).toBe(404);
    }
    expect((await mcp(tok, { username: "bob", action: "end", id: bobs })).error).toBe(true);
  });
});
