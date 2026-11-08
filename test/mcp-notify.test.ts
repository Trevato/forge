/**
 * The `notify` tool is the Settings page's notify URL over MCP: the same
 * refusals, the same event, the same token scope for a change.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { notifyUrlOf } from "../src/crew/notify.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP notify", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceId = "";
  let admin = "";
  let narrow = "";
  let ro = "";
  let botToken = "";
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
        params: { name: "notify", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return { text, error: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-notify-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
      trusted: true,
    });
    if (!a.ok) throw new Error("users");
    aliceId = a.value.id;
    admin = createToken(app.db, aliceId, "admin", "admin").token;
    narrow = createToken(app.db, aliceId, "rw", "rw").token;
    ro = createToken(app.db, aliceId, "ro", "ro").token;
    const bot = await createAgent(app, a.value, { username: "bot" });
    if (!bot.ok) throw new Error("agent");
    botToken = createToken(app.db, bot.value.user.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("set, then read back its host only; empty turns it off", async () => {
    expect(JSON.parse((await call(admin, {})).text)).toEqual({ set: false, host: null });
    const heard: string[] = [];
    const off = app.bus.subscribe((e) => heard.push(e.kind));
    const set = await call(admin, { url: "https://ntfy.example.com/secret-topic" });
    off();
    expect(JSON.parse(set.text)).toEqual({ set: true, host: "ntfy.example.com" });
    expect(heard).toContain("account.notify_set");
    const read = await call(narrow, {});
    expect(read.text).not.toContain("secret-topic");
    expect(JSON.parse(read.text)).toEqual({ set: true, host: "ntfy.example.com" });
    const cleared = await call(admin, { url: "" });
    expect(JSON.parse(cleared.text)).toEqual({ set: false, host: null });
    expect(notifyUrlOf(app.db, aliceId)).toBeUndefined();
  });

  test("a private-network or non-https address is refused and nothing is written", async () => {
    const priv = await call(admin, { url: "https://192.168.1.5/topic" });
    expect(priv.error).toBe(true);
    expect(priv.text).toContain("inside a network");
    expect((await call(admin, { url: "http://ntfy.example.com/x" })).error).toBe(true);
    expect((await call(admin, { url: 5 })).error).toBe(true);
    expect(notifyUrlOf(app.db, aliceId)).toBeUndefined();
  });

  test("a token narrower than the page needs may read but not change", async () => {
    const refused = await call(narrow, { url: "https://ntfy.example.com/x" });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("forbidden");
    expect(notifyUrlOf(app.db, aliceId)).toBeUndefined();
  });

  test("a read-only token reads the host but cannot change it", async () => {
    expect(JSON.parse((await call(ro, {})).text)).toEqual({ set: false, host: null });
    const refused = await call(ro, { url: "https://ntfy.example.com/x" });
    expect(refused.error).toBe(true);
    expect(notifyUrlOf(app.db, aliceId)).toBeUndefined();
  });

  test("an agent token is refused", async () => {
    const read = await call(botToken, {});
    expect(read.error).toBe(true);
    expect(read.text).toContain("forbidden");
    expect((await call(botToken, { url: "https://ntfy.example.com/x" })).error).toBe(true);
  });
});
