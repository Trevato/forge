/** The `assigned` tool answers what GET /api/v1/user/assigned answers: what is mine, across repositories. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP assigned", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let bobTok: string;
  let carolTok: string;
  let id = 1;

  const call = async (token: string, args: unknown = {}) => {
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
        params: { name: "assigned", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-assigned-"));
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
    const bob = await mk("bob");
    const carol = await mk("carol");
    bobTok = createToken(app.db, bob.id, "ro", "ro").token;
    carolTok = createToken(app.db, carol.id, "ro", "ro").token;
    for (const name of ["one", "two"]) {
      const made = await createRepo(app, alice, { name, visibility: "public" });
      if (!made.ok) throw new Error(String(made.error));
      const issue = createIssue(app.db, { repoId: made.value.id, authorId: alice.id, title: `task in ${name}` });
      if (!issue.ok) throw new Error(issue.error);
      app.db.query("UPDATE issue SET assignee_id = ?1 WHERE id = ?2").run(bob.id, issue.value.id);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an assignee sees the item in each repository, and the tool matches the API", async () => {
    const got = await call(bobTok);
    const names = got.value.items.map((i: any) => `${i.repo.owner}/${i.repo.name}#${i.number}`).sort();
    expect(names).toEqual(["alice/one#1", "alice/two#1"]);
    expect(got.value.items[0].title).toStartWith("task in");
    const api: any = await (
      await fetch(`${servers.url}/api/v1/user/assigned`, { headers: { authorization: `Bearer ${bobTok}` } })
    ).json();
    expect(got.value).toEqual(api);
    expect((await call(bobTok, { limit: 1 })).value.items.length).toBe(1);
    expect((await call(bobTok, { limit: 0 })).error).toContain("limit");
  });

  test("after losing access to one repository, only the other is listed", async () => {
    app.db.query("UPDATE repo SET visibility = 'private' WHERE name = 'two'").run();
    const got = await call(bobTok);
    expect(got.value.items.map((i: any) => i.repo.name)).toEqual(["one"]);
  });

  test("an unassigned person sees none", async () => {
    expect((await call(carolTok)).value.items).toEqual([]);
  });
});
