/** MCP `map` with `first: N` puts a ready issue first for a writer; a reader is forbidden, a closed or blocked issue invalid. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP map first", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let carolTok: string;
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
        params: { name: "map", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-map-first-"));
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
      promote(app.db, u.value);
      return u.value;
    };
    const alice = await mk("alice", true);
    const carol = await mk("carol");
    aliceTok = createToken(app.db, alice.id, "rw", "rw").token;
    carolTok = createToken(app.db, carol.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "one", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = made.value.id;
    const open = (title: string) => {
      const i = createIssue(app.db, { repoId, authorId: alice.id, title });
      if (!i.ok) throw new Error(i.error);
      return i.value;
    };
    open("one");
    open("two");
    open("three");
    const blocked = open("four");
    const blocker = open("five");
    const dep = addDependency(app.db, blocked, blocker, alice.id);
    if (!dep.ok) throw new Error(String(dep.error));
    const closed = open("six");
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(closed.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const readyNumbers = (v: any): number[] => v.ready.map((r: any) => r.number ?? r.issue?.number);

  test("a writer puts a ready issue first and the answer lists it first", async () => {
    const before = await call(aliceTok, { app: "alice/one" });
    expect(readyNumbers(before.value)[0]).not.toBe(3);
    const put = await call(aliceTok, { app: "alice/one", first: 3 });
    expect(put.error).toBeUndefined();
    expect(readyNumbers(put.value)[0]).toBe(3);
    expect(readyNumbers((await call(aliceTok, { app: "alice/one" })).value)[0]).toBe(3);
  });

  test("a reader is forbidden", async () => {
    const r = await call(carolTok, { app: "alice/one", first: 2 });
    expect(r.error).not.toContain("invalid");
    expect(r.error).toContain("forbidden");
    expect(readyNumbers((await call(carolTok, { app: "alice/one" })).value)[0]).toBe(3);
  });

  test("a blocked, a closed and a missing issue are invalid or unknown", async () => {
    expect((await call(aliceTok, { app: "alice/one", first: 4 })).error).toContain("invalid");
    expect((await call(aliceTok, { app: "alice/one", first: 6 })).error).toContain("invalid");
    expect((await call(aliceTok, { app: "alice/one", first: 99 })).error).toContain("no_such_issue");
  });
});
