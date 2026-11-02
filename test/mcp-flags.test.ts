/** MCP `flags`: the flags page's registry, read from a harness by a forge admin. */

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

describe("MCP flags", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const call = async (token: string, name = "flags", args: Record<string, unknown> = {}) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const tokenOf = (name: string, scope: "ro" | "admin" = "ro") =>
    createToken(app.db, getUserByName(app.db, name)!.id, "t", scope).token;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-flags-"));
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

  test("an admin sees a declared flag with its default", async () => {
    const out = await call(tokenOf("alice"));
    expect(out.error).toBe(false);
    expect(JSON.parse(out.text).flags).toEqual([
      { name: "alpha", why: "shows the new board", default: false, issue: 5417 },
    ]);
  });

  test("flag_set changes the live value", async () => {
    const set = await call(tokenOf("alice", "admin"), "flag_set", { name: "alpha", value: { forge: true, percent: 30 } });
    expect(set.error).toBe(false);
    const [flag] = JSON.parse((await call(tokenOf("alice"))).text).flags;
    expect(flag.value).toEqual({ forge: true, percent: 30 });
    expect(flag.default).toBe(false);
  });

  test("a non-admin is refused in the page's words", async () => {
    const out = await call(tokenOf("bob"));
    expect(out.error).toBe(true);
    expect(out.text).toContain("Flags are set by a forge admin.");
  });

  test("an agent is refused too, even flagged admin", async () => {
    const out = await call(tokenOf("pixel"));
    expect(out.error).toBe(true);
    expect(out.text).toContain("Flags are set by a forge admin.");
  });
});
