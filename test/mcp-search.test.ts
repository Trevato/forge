/**
 * The `search` tool answers what /api/v1/search answers the same caller,
 * never more: a private repository is not found to a stranger, and bad
 * arguments stop at the boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { SEARCH_LIMIT } from "../src/actions/search.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP search", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
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
        params: { name: "search", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-search-"));
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
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    for (const [name, visibility] of [["pebble", "public"], ["secretpebble", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility });
      if (!made.ok) throw new Error(String(made.error));
      createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title: `Polish the ${name} glow` });
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a good answer: the owner finds the issue and the repository", async () => {
    const r = await tool(aliceRo, { q: "glow", kind: "issues" });
    expect(r.value.issues.map((i: any) => i.repo.name).sort()).toEqual(["pebble", "secretpebble"]);
    const repos = await tool(aliceRo, { q: "pebble", kind: "repos", repo: "alice/pebble" });
    expect(repos.value.repos.map((x: any) => x.name)).toEqual(["pebble"]);
  });

  test("a caller who cannot read a private repository finds nothing of it", async () => {
    const r = await tool(bobRo, { q: "glow", kind: "issues" });
    expect(r.value.issues.map((i: any) => i.repo.name)).toEqual(["pebble"]);
    const named = await tool(bobRo, { q: "glow", repo: "alice/secretpebble" });
    expect(named.error).toContain("no such app or repository");
  });

  test("repo is the scope, not a filter: newer matches elsewhere do not crowd it out", async () => {
    const alice = getUserByName(app.db, "alice")!;
    const noisy = await createRepo(app, alice, { name: "noisy", visibility: "public" });
    if (!noisy.ok) throw new Error(String(noisy.error));
    for (let i = 0; i < SEARCH_LIMIT + 5; i++)
      createIssue(app.db, { repoId: noisy.value.id, authorId: alice.id, title: `Polish the glow ${i}` });
    const wide = await tool(aliceRo, { q: "glow", kind: "issues" });
    expect(wide.value.issues.some((i: any) => i.repo.name === "pebble")).toBe(false);
    const scoped = await tool(aliceRo, { q: "glow", kind: "issues", repo: "alice/pebble" });
    expect(scoped.value.issues.map((i: any) => i.repo.name)).toEqual(["pebble"]);
  });

  test("bad arguments are refused", async () => {
    for (const args of [{}, { q: "" }, { q: "x".repeat(201) }, { q: 5 }, { q: "a", kind: "all" }, { q: "a", repo: 3 }]) {
      expect((await tool(aliceRo, args)).error).toBeDefined();
    }
  });
});
