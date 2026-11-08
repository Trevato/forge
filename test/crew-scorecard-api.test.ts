/**
 * The crew's scorecard for a script or an agent (#3203): GET
 * /api/v1/crew/scorecard and the MCP `scorecard` tool answer the same JSON
 * to a forge admin's admin token, 403 to anyone else, 401 to no one.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listVia } from "./mcp-list.ts";

quietLogs();

describe("the crew scorecard over the API and MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let member: string;
  let readOnly: string;
  let bobId: string;

  const get = (token?: string) =>
    fetch(`${servers.url}/api/v1/crew/scorecard`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  const rpc = (token: string, method: string, params?: unknown) =>
    fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }).then((r) => r.json() as Promise<any>);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-scorecard-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const ada = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!ada.ok) throw new Error(ada.error);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.example",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const bots: User[] = [];
    for (const username of ["smith", "idle"]) {
      const b = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!b.ok) throw new Error(b.error);
      app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(b.value.id);
      createAgentRow(app.db, { userId: b.value.id, model: "opus" });
      bots.push(b.value);
    }
    const repo = await createRepo(app, ada.value, { name: "hello", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const issue = createIssue(app.db, {
      repoId: repo.value.id,
      authorId: bots[0]!.id,
      title: "a pull",
      kind: "pull",
    });
    if (!issue.ok) throw new Error(issue.error);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid)
         VALUES (?1, 'main', 'h', 'a', 'b')`,
      )
      .run(issue.value.id);
    admin = createToken(app.db, ada.value.id, "t", "admin").token;
    readOnly = createToken(app.db, ada.value.id, "t", "ro").token;
    bobId = made.value.id;
    member = createToken(app.db, made.value.id, "t", "admin").token;
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin token reads each agent's figures, nulls kept", async () => {
    const res = await get(admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: any[] };
    const smith = body.agents.find((a) => a.username === "smith");
    expect(smith.all).toMatchObject({ opened: 1, landed: 0, reviewRounds: null, redCheckRate: null });
    expect(smith.recent.opened).toBe(1);
    expect(smith.splits).toHaveLength(1);
    expect(smith.splits[0]).toMatchObject({ model: "", prompt: "", opened: 1, meanLandMs: null });
    expect(smith.splits[0].recent.opened).toBe(1);
    const idle = body.agents.find((a) => a.username === "idle");
    expect(idle).toEqual({ username: "idle", all: null, recent: null, splits: [] });
  });

  test("wastedDays rides on the API and the MCP tool", async () => {
    const issue = app.db.query<{ repo_id: string }, []>("SELECT repo_id FROM issue LIMIT 1").get()!;
    const smith = app.db.query<{ id: string }, []>("SELECT id FROM user WHERE username = 'smith'").get()!;
    const put = (summary: string, cost: number) =>
      app.db
        .query(
          `INSERT INTO run (id, repo_id, kind, actor_id, state, summary, cost_usd)
           VALUES (?1, ?2, 'agent', ?3, 'ok', ?4, ?5)`,
        )
        .run(crypto.randomUUID(), issue.repo_id, smith.id, summary, cost);
    put("no changes pushed", 0.5);
    put("opened pull #1", 1);
    const day = new Date().toISOString().slice(0, 10);
    const api = (await get(admin).then((r) => r.json())) as { wastedDays: any[] };
    expect(api.wastedDays.find((d) => d.day === day)).toEqual({ day, wasted: 1, runs: 2, spentUsd: 0.5 });
    const called = await rpc(admin, "tools/call", { name: "scorecard", arguments: {} });
    expect(JSON.parse(called.result.content[0].text).wastedDays).toEqual(api.wastedDays);
    app.db.query("DELETE FROM run WHERE kind = 'agent'").run();
  });

  test("a non-admin gets 403, no token 401", async () => {
    expect((await get(member)).status).toBe(403);
    expect((await get()).status).toBe(401);
    const roMember = createToken(app.db, bobId, "t", "ro").token;
    expect((await get(roMember)).status).toBe(403);
    const refused = await rpc(roMember, "tools/call", { name: "scorecard", arguments: {} });
    expect(refused.error).toBeDefined();
  });

  test("an admin's read-only token reads it on both doors", async () => {
    expect((await get(readOnly)).status).toBe(200);
    const called = await rpc(readOnly, "tools/call", { name: "scorecard", arguments: {} });
    expect(called.result.isError).toBeUndefined();
    expect(JSON.parse(called.result.content[0].text)).toEqual(await get(readOnly).then((r) => r.json()));
  });

  test("the MCP tool answers the same JSON and is listed for admins only", async () => {
    const api = await get(admin).then((r) => r.json());
    const called = await rpc(admin, "tools/call", { name: "scorecard", arguments: {} });
    expect(JSON.parse(called.result.content[0].text)).toEqual(api);
    const names = (token: string) =>
      listVia((p) => rpc(token, "tools/list", p)).then((r) => r.result.tools.map((t: { name: string }) => t.name));
    expect(await names(admin)).toContain("scorecard");
    expect(await names(member)).not.toContain("scorecard");
    const refused = await rpc(member, "tools/call", { name: "scorecard", arguments: {} });
    expect(refused.error).toBeDefined();
  });
});
