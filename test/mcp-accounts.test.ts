/** The `accounts` tool lists what GET /api/v1/admin/accounts lists, for an admin only. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listVia } from "./mcp-list.ts";

describe("MCP accounts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adminToken: string;
  let bobToken: string;
  let id = 1;

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
  const accounts = async (token: string, args: unknown = {}) => {
    const body = await rpc(token, "tools/call", { name: "accounts", arguments: args });
    if (body.error) return { refused: body.error.message as string };
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-accounts-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    await mk("carol");
    app.db.query("UPDATE user SET suspended_at = ?1 WHERE username = 'carol'").run(new Date().toISOString());
    adminToken = createToken(app.db, alice.id, "ro", "ro").token;
    bobToken = createToken(app.db, bob.id, "ro", "ro").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin lists three accounts and sees the suspended one marked", async () => {
    const r = await accounts(adminToken);
    const items = r.value.items;
    expect(items.map((i: any) => i.username).sort()).toEqual(["alice", "bob", "carol"]);
    const by = (n: string) => items.find((i: any) => i.username === n);
    expect(by("alice").role).toBe("admin");
    expect(by("carol").suspended).toBe(true);
    expect(by("bob").suspended).toBe(false);
    expect(typeof by("bob").verified).toBe("boolean");
    expect(JSON.stringify(r.value)).not.toContain("@forge.local");
  });

  test("limit pages with a cursor", async () => {
    const one = await accounts(adminToken, { limit: 2 });
    expect(one.value.items).toHaveLength(2);
    expect(one.value.next).not.toBeNull();
    const two = await accounts(adminToken, { limit: 2, cursor: one.value.next });
    expect(two.value.items).toHaveLength(1);
    expect(two.value.next).toBeNull();
    expect((await accounts(adminToken, { limit: 0 })).error).toBeDefined();
    expect((await accounts(adminToken, { cursor: "x" })).error).toBeDefined();
  });

  test("a non-admin is not listed the tool and is refused it", async () => {
    const list = await listVia((p) => rpc(bobToken, "tools/list", p));
    expect(list.result.tools.map((t: any) => t.name)).not.toContain("accounts");
    const admin = await listVia((p) => rpc(adminToken, "tools/list", p));
    expect(admin.result.tools.map((t: any) => t.name)).toContain("accounts");
    expect((await accounts(bobToken)).refused).toContain("no tool named accounts");
  });
});
