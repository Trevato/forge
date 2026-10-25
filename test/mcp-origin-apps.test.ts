/**
 * The `origin_apps` tool is the API's /user/origin-apps routes over MCP: the
 * caller's own apps only, and a client secret never read back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP origin_apps", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let aliceRw: string;
  let bob: string;
  let id = 1;
  const SECRET = "gh-client-secret-xyz";

  const tool = async (token: string, args: unknown) => {
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
        params: { name: "origin_apps", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text), text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-oapps-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    alice = createToken(app.db, a.value.id, "admin", "admin").token;
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bob = createToken(app.db, b.value.id, "admin", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person adds, lists and removes an app, and no answer carries the secret", async () => {
    const added = await tool(alice, { action: "add", kind: "github", clientId: "Iv1.abc", clientSecret: SECRET });
    expect(added.value.hasSecret).toBe(true);
    expect(added.value.clientId).toBe("Iv1.abc");
    expect(added.text).not.toContain(SECRET);
    const listed = await tool(alice, { action: "list" });
    expect(listed.value.items.map((i: any) => i.id)).toEqual([added.value.id]);
    expect(listed.text).not.toContain(SECRET);
    expect((await tool(alice, { action: "remove", id: added.value.id })).value).toEqual({});
    expect((await tool(alice, { action: "list" })).value.items).toEqual([]);
  });

  test("another person neither sees nor removes it", async () => {
    const added = await tool(alice, { action: "add", kind: "github", clientId: "Iv1.abc", clientSecret: SECRET });
    expect((await tool(bob, { action: "list" })).value.items).toEqual([]);
    const gone = await tool(bob, { action: "remove", id: added.value.id });
    expect(gone.error).toContain("not_found");
    expect(gone.error).not.toContain(SECRET);
    expect((await tool(alice, { action: "list" })).value.items).toHaveLength(1);
  });

  test("a missing field, a bad action or a lesser token is refused, never echoing the secret", async () => {
    const noId = await tool(alice, { action: "add", kind: "github", clientSecret: SECRET });
    expect(noId.error).toContain("clientId");
    expect(noId.error).not.toContain(SECRET);
    expect((await tool(alice, { action: "add", clientId: "x", clientSecret: SECRET })).error).toContain("host");
    expect((await tool(alice, { action: "remove" })).error).toContain("id");
    expect((await tool(alice, { action: "add", kind: "gitlab", clientId: "x" })).error).toContain("kind");
    expect((await tool(alice, { action: "burn" })).error).toContain("list, add or remove");
    const unknown = await tool(alice, { action: "add", host: "not a host", clientId: "x", clientSecret: SECRET });
    expect(unknown.error).toContain("does not look like a forge host");
    expect(unknown.error).not.toContain(SECRET);
    expect((await tool(aliceRw, { action: "list" })).error).toContain("admin-scope");
  });
});
