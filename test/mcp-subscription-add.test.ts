/**
 * The `subscription_add` tool is the Subscriptions page's add, over MCP: an
 * admin only, the page's words for each refusal, and the token never read back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { listSubscriptions } from "../src/core/subscriptions.ts";
import { addRefusal } from "../src/core/subscriptions_words.ts";
import { createSession } from "../src/core/sessions.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listVia } from "./mcp-list.ts";

describe("MCP subscription_add", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let bob: string;
  let aliceId: string;
  let id = 1;
  const TOKEN = "sk-ant-oat01-secret-token-value-xyz";

  const rpc = async (token: string, method: string, params: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await res.json()) as any;
  };
  const tool = async (token: string, args: unknown) => {
    const body = await rpc(token, "tools/call", { name: "subscription_add", arguments: args });
    if (body.error) return { error: JSON.stringify(body.error) };
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text), text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-subadd-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    aliceId = a.value.id;
    alice = createToken(app.db, a.value.id, "admin", "admin").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin adds one and it is in the pool, marked as a write", async () => {
    const added = await tool(alice, { name: "Team Max", token: TOKEN });
    expect(added.value.name).toBe("Team Max");
    expect(added.value.says).toContain("is in the pool");
    const listed = listSubscriptions(app.db);
    expect(listed.map((s) => s.id)).toContain(added.value.id);
    expect(listed.find((s) => s.id === added.value.id)!.createdBy).toBe(aliceId);
    const page = await fetch(`${servers.url}/settings/subscriptions`, {
      headers: { cookie: `forge_session=${createSession(app.db, aliceId).token}` },
    }).then((r) => r.text());
    expect(page).toContain("Team Max");
    expect(page).not.toContain(TOKEN);
    const tools = (await listVia((p) => rpc(alice, "tools/list", p))).result.tools;
    const t = tools.find((x: any) => x.name === "subscription_add");
    expect(t.annotations?.readOnlyHint).toBeUndefined();
  });

  test("a taken name is refused", async () => {
    const again = await tool(alice, { name: "Team Max", token: TOKEN });
    expect(again.error).toContain(addRefusal("name_taken", "Team Max"));
  });

  test("a bad token is refused with the page's words", async () => {
    const bad = await tool(alice, { name: "Other", token: "  \u200b " });
    expect(bad.error).toContain(addRefusal("invalid_token", "Other"));
    expect(bad.error).toContain("claude setup-token");
    expect(bad.error).not.toContain("no spaces");
    const base = await tool(alice, { name: "Other", token: TOKEN, apiBase: "https://x.example" });
    expect(base.error).toContain(addRefusal("invalid_api_base", "Other"));
  });

  test("a person who is not an admin is refused", async () => {
    const res = await rpc(bob, "tools/call", {
      name: "subscription_add",
      arguments: { name: "Bobs", token: TOKEN },
    });
    expect(res.error ?? res.result.isError).toBeTruthy();
    expect(listSubscriptions(app.db).some((s) => s.name === "Bobs")).toBe(false);
  });

  test("an admin's rw token is refused, and nothing is stored", async () => {
    const rw = createToken(app.db, aliceId, "rw", "rw").token;
    const res = await tool(rw, { name: "Sneaky", token: TOKEN });
    expect(res.error).toContain("no tool named");
    expect(res.error).not.toContain(TOKEN);
    expect(listSubscriptions(app.db).some((s) => s.name === "Sneaky")).toBe(false);
  });

  test("neither the answer nor any stored event carries the token", async () => {
    const added = await tool(alice, { name: "Quiet", token: TOKEN });
    expect(added.text).not.toContain(TOKEN);
    const bad = await tool(alice, { name: "Quiet", token: TOKEN });
    expect(bad.error).not.toContain(TOKEN);
    const tables = app.db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%event%' OR name LIKE '%log%' OR name LIKE '%audit%')")
      .all() as { name: string }[];
    for (const { name } of tables)
      expect(JSON.stringify(app.db.query(`SELECT * FROM "${name}"`).all())).not.toContain(TOKEN);
  });
});
