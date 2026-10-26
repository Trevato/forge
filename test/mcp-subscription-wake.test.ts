/** MCP `subscription_wake`: the Subscriptions page's Wake button, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { addSubscription, getSubscription, restSubscription } from "../src/core/subscriptions.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-wake-passphrase";

describe("MCP subscription_wake", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const id = (name: string) => getUserByName(app.db, name)!.id;
  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "subscription_wake", arguments: args } }),
    });
    const body = (await res.json()) as any;
    if (!body.result) return { error: true, text: String(body.error?.message ?? "") };
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-wake-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a resting subscription is no longer resting after the call", async () => {
    const added = addSubscription(app.db, dataDir, { name: "resting-one", token: "sk-ant-oat01-" + "a".repeat(40) });
    if (!added.ok) throw new Error(added.error);
    const sub = added.value;
    restSubscription(app.db, sub.id, new Date(Date.now() + 3600_000).toISOString(), "limit");
    expect(getSubscription(app.db, sub.id)!.restingUntil).not.toBeNull();
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const done = await mcp(admin, { id: sub.id });
    expect(done.error).toBe(false);
    expect(JSON.parse(done.text)).toEqual({ id: sub.id, says: "In use again." });
    expect(getSubscription(app.db, sub.id)!.restingUntil).toBeNull();
  });

  test("an unknown id is refused", async () => {
    const admin = createToken(app.db, id("alice"), "t", "admin").token;
    const done = await mcp(admin, { id: "nope" });
    expect(done.error).toBe(true);
    expect(done.text).toContain("no such subscription");
  });

  test("a non-admin is refused", async () => {
    const added = addSubscription(app.db, dataDir, { name: "resting-two", token: "sk-ant-oat01-" + "b".repeat(40) });
    if (!added.ok) throw new Error(added.error);
    restSubscription(app.db, added.value.id, new Date(Date.now() + 3600_000).toISOString(), "limit");
    const bob = createToken(app.db, id("bob"), "t", "admin").token;
    const done = await mcp(bob, { id: added.value.id });
    expect(done.error).toBe(true);
    expect(getSubscription(app.db, added.value.id)!.restingUntil).not.toBeNull();
  });
});
