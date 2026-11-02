/** The `hooks` tool is `…/hooks` over MCP: the same actions, the same gate. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { listVia } from "./mcp-list.ts";

describe("MCP hooks", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceAdmin: string;
  let aliceRw: string;
  let bobAdmin: string;
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
  const tool = async (token: string, args: unknown) => {
    const body = await rpc(token, "tools/call", { name: "hooks", arguments: args });
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-hooks-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    aliceAdmin = createToken(app.db, a.value.id, "a", "admin").token;
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bobAdmin = createToken(app.db, b.value.id, "b", "admin").token;
    const made = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin adds, lists and removes a hook, and its secret is never echoed", async () => {
    const added = await tool(aliceAdmin, { repo: "alice/game", action: "add", url: "https://example.com/h", secret: "s3cret-value-long-enough" });
    expect(added.value.url).toBe("https://example.com/h");
    expect(added.value.kinds).toBe("*");
    expect(JSON.stringify(added)).not.toContain("s3cret-value-long-enough");
    const listed = await tool(aliceAdmin, { repo: "alice/game", action: "list" });
    expect(listed.value.items.map((h: any) => h.id)).toEqual([added.value.id]);
    expect(JSON.stringify(listed)).not.toContain("s3cret-value-long-enough");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "remove", id: added.value.id })).value).toEqual({});
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list" })).value).toEqual({ items: [], next_cursor: null });
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "remove", id: added.value.id })).error).toContain("not_found");
  });

  test("deliveries answers the hook's last deliveries as the route does, and refuses as it does", async () => {
    const added = await tool(aliceAdmin, { repo: "alice/game", action: "add", url: "https://example.com/d", secret: "0123456789abcdef" });
    const repoId = app.db.query<{ id: string }, []>("SELECT id FROM repo WHERE name='game'").get()!.id;
    app.bus.append({ kind: "push", repoId });
    const got = await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: added.value.id });
    expect(got.value.items.length).toBeGreaterThan(0);
    expect(got.value.items[0].kind).toBe("push");
    expect(JSON.stringify(got)).not.toContain("0123456789abcdef");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "deliveries", id: "nope" })).error).toContain("not_found");
    expect((await tool(bobAdmin, { repo: "alice/game", action: "deliveries", id: added.value.id })).error).toContain("not_found");
    await tool(aliceAdmin, { repo: "alice/game", action: "remove", id: added.value.id });
  });

  test("list pages by limit and cursor, and refuses what the route refuses", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await tool(aliceAdmin, { repo: "alice/game", action: "add", url: `https://example.com/p${i}`, secret: "0123456789abcdef" });
      ids.push(a.value.id);
    }
    ids.sort();
    const first = await tool(aliceAdmin, { repo: "alice/game", action: "list", limit: 2 });
    expect(first.value.items.map((h: any) => h.id)).toEqual(ids.slice(0, 2));
    expect(first.value.next_cursor).toBe(ids[1]);
    const second = await tool(aliceAdmin, { repo: "alice/game", action: "list", limit: 2, cursor: first.value.next_cursor });
    expect(second.value.items.map((h: any) => h.id)).toEqual([ids[2]]);
    expect(second.value.next_cursor).toBeNull();
    for (const limit of [0, 201, 1.5, "5"])
      expect((await tool(aliceAdmin, { repo: "alice/game", action: "list", limit })).error).toContain("invalid_limit");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list", cursor: "gone" })).error).toContain("invalid_cursor");
    for (const id of ids) await tool(aliceAdmin, { repo: "alice/game", action: "remove", id });
  });

  test("a reader is refused and nothing is added", async () => {
    for (const args of [
      { repo: "alice/game", action: "add", url: "https://example.com/x", secret: "0123456789abcdef" },
      { repo: "alice/game", action: "list" },
    ])
      expect((await tool(bobAdmin, args)).error).toContain("not_found");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list" })).value).toEqual({ items: [], next_cursor: null });
  });

  test("an invalid URL is refused with the API's error", async () => {
    for (const url of ["http://example.com/h", "nonsense", ""])
      expect((await tool(aliceAdmin, { repo: "alice/game", action: "add", url, secret: "0123456789abcdef" })).error).toContain("invalid_url");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "nope" })).error).toContain("action is list");
  });

  test("lengths are enforced, and a secret of 16 or more is required", async () => {
    const base = { repo: "alice/game", action: "add", secret: "0123456789abcdef" };
    const long = await tool(aliceAdmin, { ...base, url: "https://example.com/" + "a".repeat(2048) });
    expect(long.error).toContain("url is text of at most 2048");
    const kinds = await tool(aliceAdmin, { ...base, url: "https://example.com/h", kinds: "k".repeat(201) });
    expect(kinds.error).toContain("kinds is text of at most 200");
    expect((await tool(aliceAdmin, { ...base, url: "https://example.com/h", secret: "x".repeat(201) })).error).toContain("secret is text");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "remove", id: "i".repeat(65) })).error).toContain("id is text");
    for (const secret of [undefined, "short"])
      expect((await tool(aliceAdmin, { repo: "alice/game", action: "add", url: "https://example.com/h", secret })).error).toContain("secret is required");
    expect((await tool(aliceAdmin, { repo: "alice/game", action: "list" })).value).toEqual({ items: [], next_cursor: null });
  });

  test("it is listed, and callable, only with an admin-scope token", async () => {
    const names = async (t: string) => (await listVia((p) => rpc(t, "tools/list", p))).result.tools.map((x: any) => x.name);
    expect(await names(aliceAdmin)).toContain("hooks");
    expect(await names(aliceRw)).not.toContain("hooks");
    const called = await rpc(aliceRw, "tools/call", { name: "hooks", arguments: { repo: "alice/game", action: "list" } });
    expect(called.error.message).toContain("no tool named hooks");
  });
});
