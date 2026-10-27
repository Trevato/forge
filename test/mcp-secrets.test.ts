/**
 * The `secrets` tool is /api/v1/secrets over MCP: the same actions, admins
 * only, and no answer ever carries a value.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { listVia } from "./mcp-list.ts";

describe("MCP secrets", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let adminRw: string;
  let other: string;
  let id = 1;
  const VALUE = "s3cr3t-value-that-must-not-leak";

  const rpc = async (token: string, method: string, params?: unknown) => {
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
    const body = await rpc(token, "tools/call", { name: "secrets", arguments: args });
    const text: string = body.result.content[0].text;
    return { text, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-secrets-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    adminRw = createToken(app.db, a.value.id, "rw", "rw").token;
    other = createToken(app.db, b.value.id, "rw", "rw").token;
    const org = createOrg(app.db, "acme", a.value.id);
    if (!org.ok) throw new Error(org.error);
    const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  for (const [scope, ref] of [
    ["forge", undefined],
    ["org", "acme"],
    ["repo", "alice/game"],
  ] as const) {
    test(`an admin sets, lists and removes at the ${scope} scope, and no answer holds the value`, async () => {
      const base = { scope, ref };
      const set = await tool(admin, { ...base, action: "set", name: "API_KEY", value: VALUE });
      expect(set.isError).toBe(false);
      const list = await tool(admin, { ...base, action: "list" });
      expect(JSON.parse(list.text).items.map((s: any) => s.name)).toEqual(["API_KEY"]);
      const gone = await tool(admin, { ...base, action: "remove", name: "API_KEY" });
      expect(gone.isError).toBe(false);
      const after = await tool(admin, { ...base, action: "list" });
      expect(JSON.parse(after.text).items).toEqual([]);
      const missing = await tool(admin, { ...base, action: "remove", name: "API_KEY" });
      expect(missing.isError).toBe(true);
      for (const a of [set, list, gone, after, missing]) expect(a.text).not.toContain(VALUE);
    });
  }

  test("a bad value or scope is refused with the API's error, never echoing the value", async () => {
    const scope = await tool(admin, { scope: "moon", action: "set", name: "K", value: VALUE });
    expect(scope.isError).toBe(true);
    expect(scope.text).toContain("invalid_scope");
    expect(scope.text).not.toContain(VALUE);
    const name = await tool(admin, { scope: "forge", action: "set", name: "bad name", value: VALUE });
    expect(name.text).toContain("invalid_name");
    expect(name.text).not.toContain(VALUE);
    const action = await tool(admin, { scope: "forge", action: "peek" });
    expect(action.isError).toBe(true);
  });

  test("an admin's rw token is refused on list, set and remove, and nothing changes", async () => {
    await tool(admin, { scope: "forge", action: "set", name: "KEPT", value: VALUE });
    for (const args of [
      { scope: "forge", action: "list" },
      { scope: "forge", action: "set", name: "KEPT", value: "overwritten" },
      { scope: "forge", action: "remove", name: "KEPT" },
    ]) {
      const r = await tool(adminRw, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("forbidden");
    }
    const list = await tool(admin, { scope: "forge", action: "list" });
    expect(JSON.parse(list.text).items.map((s: any) => s.name)).toEqual(["KEPT"]);
    await tool(admin, { scope: "forge", action: "remove", name: "KEPT" });
  });

  test("a non-admin is refused and not listed the tool", async () => {
    const listed = await listVia((p) => rpc(other, "tools/list", p));
    expect(listed.result.tools.map((t: any) => t.name)).not.toContain("secrets");
    const seen = await listVia((p) => rpc(admin, "tools/list", p));
    expect(seen.result.tools.map((t: any) => t.name)).toContain("secrets");
    const call = await rpc(other, "tools/call", {
      name: "secrets",
      arguments: { scope: "forge", action: "set", name: "API_KEY", value: VALUE },
    });
    expect(call.error ?? call.result.isError).toBeTruthy();
    expect(JSON.stringify(call)).not.toContain(VALUE);
    const after = await tool(admin, { scope: "forge", action: "list" });
    expect(JSON.parse(after.text).items).toEqual([]);
  });
});
