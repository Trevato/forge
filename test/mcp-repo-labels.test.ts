/** `repo_labels` is the labels routes over MCP: the same actions, so the same gates. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listAt } from "./mcp-list.ts";

describe("MCP repo_labels", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let adminRw: string;
  let bob: string;
  let ro: string;
  let n = 1;

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
        id: n++,
        method: "tools/call",
        params: { name: "repo_labels", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const R = "alice/game";

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-repo-labels-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, {
        origin: "seed", trusted: true, username,
        email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice", true);
    const b = await mk("bob");
    admin = createToken(app.db, alice.id, "a", "admin").token;
    adminRw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
    bob = createToken(app.db, b.id, "b", "admin").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("it is listed with a schema", async () => {
    const body = await listAt(servers.url, admin);
    const t = body.result.tools.find((x: any) => x.name === "repo_labels");
    expect(t.inputSchema.required).toEqual(["repo"]);
  });

  test("an admin creates, lists and removes", async () => {
    const made = await call(admin, { repo: R, action: "create", name: "bug", color: "D73A4A" });
    expect(made.value.label.color).toBe("d73a4a");
    expect(made.value.says).toContain("bug");
    const listed = await call(admin, { repo: R, action: "list" });
    expect(listed.value.items.map((l: any) => l.name)).toEqual(["bug"]);
    const gone = await call(admin, { repo: R, action: "remove", id: made.value.label.id });
    expect(gone.value.says).toContain("Removed");
    expect((await call(admin, { repo: R })).value.items).toEqual([]);
  });

  test("a duplicate and a bad color are refused", async () => {
    await call(admin, { repo: R, action: "create", name: "ui" });
    const dup = await call(admin, { repo: R, action: "create", name: "UI" });
    expect(dup.error).toContain("taken: A label with that name already exists.");
    const color = await call(admin, { repo: R, action: "create", name: "x", color: "red" });
    expect(color.error).toContain("six hex digits");
  });

  test("a stranger or reader cannot change them, and a missing label is not found", async () => {
    const before = (await call(admin, { repo: R })).value.items;
    const c = await call(bob, { repo: R, action: "create", name: "evil" });
    expect(c.error).toContain("not_found");
    const r = await call(bob, { repo: R, action: "remove", id: before[0].id });
    expect(r.error).toContain("not_found");
    // A reader sees the same labels, without the writer-only `open` count.
    expect((await call(bob, { repo: R })).value.items).toEqual(before.map(({ open: _open, ...l }: any) => l));
    expect((await call(adminRw, { repo: R, action: "create", name: "no" })).error).toContain("admin token");
    expect((await call(admin, { repo: R, action: "remove", id: "nope" })).error).toContain("not_found");
  });

  test("list pages by limit and cursor, and refuses what the route refuses", async () => {
    for (const name of ["pa", "pb", "pc"]) await call(admin, { repo: R, action: "create", name, color: "aabbcc" });
    const first = await call(admin, { repo: R, action: "list", limit: 2 });
    expect(first.value.items.map((l: any) => l.name)).toEqual(["pa", "pb"]);
    expect(first.value.next_cursor).toBe(first.value.items[1].id);
    const second = await call(admin, { repo: R, action: "list", limit: 3, cursor: first.value.next_cursor });
    expect(second.value.items.map((l: any) => l.name)).toEqual(["pc", "ui"]);
    expect(second.value.next_cursor).toBeNull();
    for (const limit of [0, 201, 1.5, "5"])
      expect((await call(admin, { repo: R, action: "list", limit })).error).toContain("invalid_limit");
    expect((await call(admin, { repo: R, action: "list", cursor: "gone" })).error).toContain("invalid_cursor");
    for (const l of (await call(admin, { repo: R, action: "list" })).value.items)
      await call(admin, { repo: R, action: "remove", id: l.id });
  });

  test("a read-only token lists, named or by default, and cannot change", async () => {
    expect(Array.isArray((await call(ro, { repo: R })).value.items)).toBe(true);
    expect(Array.isArray((await call(ro, { repo: R, action: "list" })).value.items)).toBe(true);
    const c = await call(ro, { repo: R, action: "create", name: "x" });
    expect(c.error).toBe("forbidden: this token may read, not act");
    const r = await call(ro, { repo: R, action: "remove", id: "nope" });
    expect(r.error).toBe("forbidden: this token may read, not act");
  });

  test("bad arguments are one-sentence refusals", async () => {
    for (const args of [
      { repo: R, action: "burn" },
      { repo: R, action: "create" },
      { repo: R, action: "create", name: 5 },
      { repo: R, action: "create", name: "x".repeat(65) },
      { repo: R, action: "remove" },
      { repo: R, action: "remove", id: 7 },
      { repo: "nope" },
    ])
      expect((await call(admin, args)).error).toBeDefined();
  });
});
