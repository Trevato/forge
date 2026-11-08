/**
 * The `pins` tool is /api/v1/user/pins over MCP: the caller's own pins, the
 * same visibility rule, the same scope gate.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP pins", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRw: string;
  let bobRw: string;
  let bobRo: string;
  let id = 1;

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
        params: { name: "pins", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const listed = async (token: string) =>
    (await tool(token, {})).value.pins.map((p: any) => p.repo);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-pins-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    for (const [name, visibility] of [["open", "public"], ["secret", "private"], ["later", "public"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person pins, lists and unpins; the list is theirs alone", async () => {
    expect(await listed(bobRw)).toEqual([]);
    expect((await tool(bobRw, { action: "pin", repo: "alice/open" })).value).toEqual({
      repo: "alice/open",
      pinned: true,
    });
    expect(await listed(bobRw)).toEqual(["alice/open"]);
    expect(await listed(aliceRw)).toEqual([]);
    expect((await tool(bobRw, { action: "unpin", repo: "alice/open" })).value.pinned).toBe(false);
    expect(await listed(bobRw)).toEqual([]);
    expect((await tool(bobRw, { action: "unpin", repo: "alice/open" })).error).toContain("not_found");
  });

  test("a private repository the caller cannot see is not found", async () => {
    expect((await tool(bobRw, { action: "pin", repo: "alice/secret" })).error).toContain("not_found");
    expect((await tool(bobRw, { action: "pin", repo: "alice/nope" })).error).toContain("not_found");
    expect(await listed(bobRw)).toEqual([]);
    expect((await tool(aliceRw, { action: "pin", repo: "alice/secret" })).value.pinned).toBe(true);
  });

  test("a pin on a repository that later went private is no longer listed", async () => {
    await tool(bobRw, { action: "pin", repo: "alice/later" });
    expect(await listed(bobRw)).toEqual(["alice/later"]);
    app.db.run("UPDATE repo SET visibility = 'private' WHERE name = 'later'");
    expect(await listed(bobRw)).toEqual([]);
    expect(await listed(aliceRw)).not.toContain("alice/later");
    await tool(aliceRw, { action: "pin", repo: "alice/later" });
    expect(await listed(aliceRw)).toContain("alice/later");
  });

  test("list pages by owner/name with limit and cursor", async () => {
    for (const n of ["pa", "pb", "pc"]) {
      app.db.run(
        "INSERT INTO repo (id, owner_id, name, visibility, default_branch) SELECT 'pg-' || ?1, owner_id, ?1, 'public', 'main' FROM repo WHERE name = 'open'",
        [n],
      );
      await tool(bobRw, { action: "pin", repo: `alice/${n}` });
    }
    const first = (await tool(bobRw, { limit: 2 })).value;
    expect(first.pins.map((p: any) => p.repo)).toEqual(["alice/pa", "alice/pb"]);
    expect(first.next_cursor).toBe("alice/pb");
    const second = (await tool(bobRw, { limit: 2, cursor: first.next_cursor })).value;
    expect(second.pins.map((p: any) => p.repo)).toContain("alice/pc");
    expect(second.next_cursor).toBeNull();
    expect((await tool(bobRw, { limit: "x" })).error).toContain("invalid");
    for (const bad of [0, -5, 9999, 201, 1.5, "x"])
      expect((await tool(bobRw, { limit: bad })).error).toContain("invalid_limit");
    expect((await tool(bobRw, { limit: 1 })).value.pins).toHaveLength(1);
    expect((await tool(bobRw, { limit: 200 })).value.pins.length).toBeGreaterThan(0);
    for (const n of ["pa", "pb", "pc"]) await tool(bobRw, { action: "unpin", repo: `alice/${n}` });
  });

  test("a read-only token lists but is refused pin and unpin; a bad action is invalid", async () => {
    expect(await listed(bobRo)).toEqual([]);
    expect((await tool(bobRo, { action: "pin", repo: "alice/open" })).error).toContain("forbidden");
    expect((await tool(bobRo, { action: "unpin", repo: "alice/open" })).error).toContain("forbidden");
    expect((await tool(bobRw, { action: "nuke", repo: "alice/open" })).error).toContain("invalid");
  });
});
