/** MCP `whoami_can` with `kind: "passkeys"`: the caller's own passkeys, never another's. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { addPasskey } from "../src/core/passkeys.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-passkey-passphrase";

describe("MCP whoami_can kind passkeys", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice = "";
  let bob = "";
  let bot = "";

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami_can", arguments: args } }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { error: true, text: body.error.message as string };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const key = (n: string): any => ({ id: `cred-${n}`, alg: -7, key: { kty: "EC", crv: "P-256", x: "x", y: "y" }, signCount: 0 });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-passkeys-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made: Record<string, any> = {};
    for (const username of ["alice", "bob"]) {
      made[username] = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin: username === "alice" });
      if (!made[username].ok) throw new Error(username);
    }
    const a = made["alice"].value.id;
    addPasskey(app.db, a, "laptop", key("1"));
    addPasskey(app.db, a, "phone", key("2"));
    addPasskey(app.db, made["bob"].value.id, "bobs-key", key("3"));
    alice = createToken(app.db, a, "t", "ro").token;
    bob = createToken(app.db, made["bob"].value.id, "t", "ro").token;
    const agent = await createAgent(app, getUserByName(app.db, "alice")!, { username: "bot" });
    if (!agent.ok) throw new Error("bot");
    bot = createToken(app.db, agent.value.user.id, "t", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person sees both of their passkeys, with no key material", async () => {
    const r = await call(alice, { kind: "passkeys" });
    expect(r.error).toBe(false);
    const { items } = JSON.parse(r.text);
    expect(items.map((i: any) => i.name)).toEqual(["laptop", "phone"]);
    expect(Object.keys(items[0]).sort()).toEqual(["created", "id", "lastUsed", "name"]);
    expect(r.text).not.toContain("cred-1");
  });

  test("another person's passkeys are never listed", async () => {
    const { items } = JSON.parse((await call(bob, { kind: "passkeys" })).text);
    expect(items.map((i: any) => i.name)).toEqual(["bobs-key"]);
  });

  test("an agent token is refused", async () => {
    const r = await call(bot, { kind: "passkeys" });
    expect(r.error).toBe(true);
    expect(r.text).toContain("no passkeys");
  });

  test("no kind still answers the role; another kind names the allowed ones", async () => {
    const r = JSON.parse((await call(alice, {})).text);
    expect(r.role).toBe("admin");
    expect(r.items).toBeUndefined();
    const bad = await call(alice, { kind: "teapots" });
    expect(bad.error).toBe(true);
    expect(bad.text).toContain("role, passkeys");
  });
});
