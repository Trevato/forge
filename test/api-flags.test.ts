/** `GET /api/v1/flags` answers what MCP `flags` answers, for the same reader (#8012). */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeFlags } from "../src/core/flags.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { useFlagRegistry } from "../src/web/pages/flags.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-flags-passphrase";
const reg = makeFlags({ alpha: { why: "shows the new board", default: false, issue: 5417 } });

describe("GET /api/v1/flags", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const tokenOf = (name: string) => createToken(app.db, getUserByName(app.db, name)!.id, "t", "ro").token;
  const get = (token: string | null) =>
    fetch(`${servers.url}/api/v1/flags`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const mcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "flags", arguments: {} } }),
    });
    return JSON.parse(((await res.json()) as any).result.content[0].text);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-api-flags-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false], ["pixel", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
    app.db.query("UPDATE user SET is_agent = 1, is_admin = 1 WHERE username = 'pixel'").run();
    useFlagRegistry(reg);
  }, 30_000);

  afterAll(async () => {
    useFlagRegistry(undefined);
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin person gets the rows MCP flags returns", async () => {
    const res = await get(tokenOf("alice"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.flags).toEqual([{ name: "alpha", why: "shows the new board", default: false, issue: 5417 }]);
    expect(body).toEqual(await mcp(tokenOf("alice")));
  });

  test("an agent admin and a plain member get 403 in the page's words", async () => {
    for (const name of ["pixel", "bob"]) {
      const res = await get(tokenOf(name));
      expect(res.status).toBe(403);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("Flags are set by a forge admin.");
    }
  });

  test("no token gets 401", async () => {
    expect((await get(null)).status).toBe(401);
  });

  test("the route is in the OpenAPI document", async () => {
    const doc = (await (await fetch(`${servers.url}/api/v1/openapi.json`)).json()) as any;
    expect(doc.paths["/api/v1/flags"].get).toBeDefined();
  });
});
