/**
 * The `subscription_headroom` tool is POST /settings/subscriptions/:id/headroom
 * over MCP: the same `headroomPct` and `setHeadroom`, so the same refusals.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { getHeadroom, HEADROOM_MAX } from "../src/core/standing.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP subscription_headroom", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  let bob = "";
  let sub = "";
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
        params: { name: "subscription_headroom", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    // A tool the caller may not see is a JSON-RPC error, not a result.
    if (!body.result) return { text: JSON.stringify(body.error), error: true };
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-headroom-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = (username: string) =>
      createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: username === "alice",
      });
    const a = await mk("alice");
    const b = await mk("bob");
    if (!a.ok || !b.ok) throw new Error("users");
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
    const s = addSubscription(app.db, dataDir, { name: "pool", token: "sk-ant-api03-key-for-the-mcp-headroom" });
    if (!s.ok) throw new Error("sub");
    sub = s.value.id;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin sets 30 and the page shows 30", async () => {
    const set = await call(admin, { id: sub, percent: 30 });
    expect(set.error).toBe(false);
    expect(JSON.parse(set.text)).toEqual({
      id: sub,
      percent: 30,
      says: "The crew now leaves 30% of each window for people.",
    });
    expect(getHeadroom(app.db, sub)).toBe(30);
    const signin = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const page = await (await fetch(`${servers.url}/settings/subscriptions`, { headers: { cookie } })).text();
    expect(page).toMatch(new RegExp(`id="h-${sub}"[^>]*value="30"`));
  });

  test("101 is refused in the page's words", async () => {
    const over = await call(admin, { id: sub, percent: 101 });
    expect(over.error).toBe(true);
    expect(over.text).toContain(`Headroom is a whole percent from 0 to ${HEADROOM_MAX}.`);
    expect(getHeadroom(app.db, sub)).toBe(30);
  });

  test("an unknown id is refused", async () => {
    const none = await call(admin, { id: "nope", percent: 10 });
    expect(none.error).toBe(true);
    expect(none.text).toContain("No such subscription.");
  });

  test("a non-admin is refused", async () => {
    expect((await call(bob, { id: sub, percent: 5 })).error).toBe(true);
    expect(getHeadroom(app.db, sub)).toBe(30);
  });
});
