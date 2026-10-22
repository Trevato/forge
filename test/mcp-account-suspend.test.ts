/** MCP `account_suspend`: the API's suspend and unsuspend, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createSession, sessionUser } from "../src/core/sessions.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-suspend-passphrase";

describe("MCP account_suspend", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const id = (name: string) => getUserByName(app.db, name)!.id;
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "account_suspend", arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const whoami = (token: string) =>
    fetch(`${servers.url}/api/v1/user`, { headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-suspend-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["dave", true], ["bob", false], ["carol", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin suspends a person, whose session and token stop, then unsuspends", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const bobTok = createToken(app.db, id("bob"), "t", "rw").token;
    const session = createSession(app.db, id("bob")).token;
    expect((await whoami(bobTok)).status).toBe(200);
    expect(sessionUser(app.db, session).ok).toBe(true);

    const off = await mcp(admin, { username: "bob", suspended: true });
    expect(off.error).toBe(false);
    expect(JSON.parse(off.text).suspendedAt).not.toBeNull();
    expect(getUserByName(app.db, "bob")!.suspendedAt).not.toBeNull();
    expect((await whoami(bobTok)).status).toBe(401);
    expect(sessionUser(app.db, session).ok).toBe(false);

    const on = await mcp(admin, { username: "bob", suspended: false });
    expect(on.error).toBe(false);
    expect(JSON.parse(on.text).suspendedAt).toBeNull();
    expect(getUserByName(app.db, "bob")!.suspendedAt).toBeNull();
  });

  test("the API's refusals hold: not yourself, not another admin, not a stranger, bad input", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    for (const username of ["alice", "dave"]) {
      const r = await mcp(admin, { username, suspended: true });
      expect(r.error).toBe(true);
      expect(r.text).toContain("cannot suspend or remove themselves, another admin, or an agent");
    }
    const nobody = await mcp(admin, { username: "nobody", suspended: true });
    expect(nobody.error).toBe(true);
    expect(nobody.text).toStartWith("not_found:");
    expect((await mcp(admin, { username: "bob", suspended: "yes" })).error).toBe(true);
    expect(getUserByName(app.db, "alice")!.suspendedAt).toBeNull();
  });

  test("the last owner of an organization is refused, with the organization named", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    expect(createOrg(app.db, "acme", id("carol")).ok).toBe(true);
    const r = await mcp(admin, { username: "carol", suspended: true });
    expect(r.error).toBe(true);
    expect(r.text).toStartWith("last_owner:");
    expect(r.text).toContain("acme");
    expect(r.text).not.toContain("confirm");
    expect(getUserByName(app.db, "carol")!.suspendedAt).toBeNull();
  });

  test("a non-admin, and an admin on a read-write token, are refused", async () => {
    const carol = createToken(app.db, id("carol"), "t", "admin").token;
    const rw = createToken(app.db, id("alice"), "t", "rw").token;
    expect((await mcp(carol, { username: "bob", suspended: true })).error).toBe(true);
    expect((await mcp(rw, { username: "bob", suspended: true })).error).toBe(true);
    expect(getUserByName(app.db, "bob")!.suspendedAt).toBeNull();
  });
});
