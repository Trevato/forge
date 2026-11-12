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
import { createRepo, setArchived } from "../src/actions/repos.ts";
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

  test("a blank q answers the empty shape with a note saying what to send", async () => {
    const r = await tool(aliceRo, { q: "  " });
    expect(r.value.repos).toEqual([]);
    expect(r.value.note).toContain("q is empty");
    expect(r.value.note).toContain("kind=all|repos|issues|code");
    expect((await tool(aliceRo, { q: "glow", kind: "issues" })).value.note).toBeUndefined();
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

  test("an unknown kind or a bad limit is refused in the API's words; every kind answers", async () => {
    expect((await tool(aliceRo, { q: "a", kind: "bogus" })).error).toContain("invalid_kind");
    expect((await tool(aliceRo, { q: "a", kind: "bogus" })).error).toContain("all, repos, issues or code");
    for (const limit of [0, 101, 1.5, "5"]) {
      const r = await tool(aliceRo, { q: "a", limit });
      expect(r.error).toContain("invalid_limit");
      expect(r.error).toContain("1 to 100");
    }
    for (const kind of ["all", "repos", "issues", "code"]) expect((await tool(aliceRo, { q: "a", kind, limit: 5 })).error).toBeUndefined();
  });

  test("bad arguments are refused", async () => {
    for (const args of [{}, { q: "x".repeat(201) }, { q: 5 }, { q: "a", repo: 3 }]) {
      expect((await tool(aliceRo, args)).error).toBeDefined();
    }
  });
});

describe("search marks an archived repository", () => {
  test("the flag in MCP rows and the badge on the page, for repos and code", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "forge-search-archived-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    try {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
        password: "a-good-passphrase", adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      const made = await createRepo(app, u.value, { name: "shelved", visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const live = await createRepo(app, u.value, { name: "shelvedlive", visibility: "public" });
      if (!live.ok) throw new Error(String(live.error));
      const token = createToken(app.db, u.value.id, "ro", "ro").token;
      const rw = createToken(app.db, u.value.id, "rw", "rw").token;
      for (const name of ["shelved", "shelvedlive"]) {
        const pushed = await fetch(`${servers.url}/api/v1/repos/alice/${name}/contents`, {
          method: "POST",
          headers: { authorization: `Bearer ${rw}`, "content-type": "application/json" },
          body: JSON.stringify({
            branch: "main", message: "needle",
            files: [{ path: "src/a-rather-long-path/to/needle.txt", content: "a quixotic needle\n" }],
          }),
        });
        expect(pushed.status).toBeLessThan(300);
      }
      const call = async (kind = "repos") => {
        const res = await fetch(`${servers.url}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0", id: 1, method: "tools/call",
            params: { name: "search", arguments: { q: kind === "repos" ? "shelved" : "quixotic", kind } },
          }),
        });
        const body: any = await res.json();
        return JSON.parse(body.result.content[0].text)[kind] as any[];
      };
      const before = await call();
      expect(before.map((r) => r.archived)).toEqual([false, false]);
      const done = await setArchived(app, u.value, made.value, true, false);
      expect(done.ok).toBe(true);
      const repoRows = await call();
      expect(repoRows.find((r) => r.name === "shelved").archived).toBe(true);
      expect(repoRows.find((r) => r.name === "shelvedlive").archived).toBe(false);

      const hits = await call("code");
      expect(hits.find((h) => h.repo.name === "shelved").archived).toBe(true);
      expect(hits.find((h) => h.repo.name === "shelvedlive").archived).toBe(false);
      const codePage = await (await fetch(`${servers.url}/search?q=quixotic&kind=code`)).text();
      const rows = codePage.split('<li>').filter((r) => r.includes("code-hit"));
      const hitRow = (name: string) => rows.find((r) => r.includes(`/alice/${name}/blob`))!.split("</li>")[0]!;
      expect(hitRow("shelved")).toContain("Archived");
      expect(hitRow("shelvedlive")).not.toContain("Archived");

      const page = await (await fetch(`${servers.url}/search?q=shelved&kind=repos`)).text();
      const parts = page.split('href="/alice/');
      const archivedRow = parts.find((p) => p.startsWith("shelved\""))!;
      const liveRow = parts.find((p) => p.startsWith("shelvedlive\""))!;
      expect(archivedRow).toContain("Archived");
      expect(liveRow.split("</li>")[0]).not.toContain("Archived");
    } finally {
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 30_000);
});
