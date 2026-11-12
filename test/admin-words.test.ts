/**
 * An admin's refusals read the same from every door (#5561): the API and MCP
 * each answer the sentence `src/actions/admin_words.ts` holds, so a door that
 * retypes the words fails here the moment they drift.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_WORDS } from "../src/actions/admin_words.ts";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("an admin's refusals, from every door", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let person = "";

  const api = async (token: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${servers.url}${path}`, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as { error: string; message: string } };
  };
  const mcp = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-admin-words-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-words-passphrase", isAdmin });
      if (!made.ok) throw new Error(username);
    }
    admin = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "admin").token;
    person = createToken(app.db, getUserByName(app.db, "bob")!.id, "t", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin suspending themselves: the API and MCP say the module's sentence", async () => {
    const r = await api(admin, "POST", "/api/v1/admin/accounts/alice/suspend", {});
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "not_allowed", message: ADMIN_WORDS.selfSuspend });
    const m = await mcp(admin, "account_suspend", { username: "alice", suspended: true });
    expect(m.error).toBe(true);
    expect(m.text).toBe(`not_allowed: ${ADMIN_WORDS.selfSuspend}`);
  });

  test("a non-admin reading the scorecard: the API says the module's sentence", async () => {
    const r = await api(person, "GET", "/api/v1/crew/scorecard");
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "forbidden", message: ADMIN_WORDS.scorecard });
  });

  test("a non-admin setting the front page: the API and MCP say the module's sentence", async () => {
    const r = await api(person, "PUT", "/api/v1/front", { pinned: [], hidden: [] });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: "forbidden", message: ADMIN_WORDS.frontPage });
    const m = await mcp(person, "front_page", { pinned: [], hidden: [] });
    expect(m.error).toBe(true);
    expect(m.text).toBe(`forbidden: ${ADMIN_WORDS.frontPage}`);
  });
});
