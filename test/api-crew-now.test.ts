/**
 * What the crew is doing right now (#7900): GET /api/v1/crew/now and the MCP
 * `now` tool answer the same JSON to the same reader; a run on a sealed
 * report the reader cannot see is absent; no one gets 401.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { mcpTool } from "./helpers/mcp.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

quietLogs();

describe("the crew's work right now over the API and MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let ada: string;
  let bob: string;
  let openRun: string;
  let sealedRun: string;
  let privateRun: string;

  const get = (token?: string) =>
    fetch(`${servers.url}/api/v1/crew/now`, {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-crew-now-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await seedAdmin(app, { username: "ada", email: "ada@forge.example" });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.example",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    const repo = await createRepo(app, a.value, { name: "hello", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    createAppRecord(app.db, { repoId: repo.value.id, slug: "hello", access: "public" });
    const open = createIssue(app.db, { repoId: repo.value.id, authorId: a.value.id, title: "open work" });
    const sealed = createIssue(app.db, {
      repoId: repo.value.id,
      authorId: a.value.id,
      title: "hole in the door",
      sealed: true,
    });
    if (!open.ok || !sealed.ok) throw new Error("issues");
    openRun = createRun(app.db, { repoId: repo.value.id, kind: "agent", issueId: open.value.id, reason: "work" }).id;
    sealedRun = createRun(app.db, { repoId: repo.value.id, kind: "agent", issueId: sealed.value.id, reason: "work" }).id;
    // A public repository whose app is private: its runs are for those who may enter it.
    const vault = await createRepo(app, a.value, { name: "vault", visibility: "public" });
    if (!vault.ok) throw new Error(String(vault.error));
    createAppRecord(app.db, { repoId: vault.value.id, slug: "vault", access: "private" });
    privateRun = createRun(app.db, { repoId: vault.value.id, kind: "agent", reason: "work" }).id;
    // The planner declined the direction on hello: the owner's fact, a waiting row with no run.
    const direction = createIssue(app.db, { repoId: repo.value.id, authorId: a.value.id, title: "make it rounder" });
    if (!direction.ok) throw new Error("direction");
    const declined = createRun(app.db, {
      repoId: repo.value.id,
      kind: "agent",
      issueId: direction.value.id,
      reason: "plan",
    });
    app.db
      .query("UPDATE run SET state = 'failed', summary = 'declined: too vague' WHERE id = ?1")
      .run(declined.id);
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous', direction_issue_id = ?2 WHERE id = ?1")
      .run(repo.value.id, direction.value.id);
    ada = createToken(app.db, a.value.id, "t", "admin").token;
    bob = createToken(app.db, b.value.id, "t", "ro").token;
  });
  afterAll(async () => {
    await servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("no credentials is 401", async () => {
    expect((await get()).status).toBe(401);
  });

  test("REST and MCP agree, and a stranger does not see the sealed run", async () => {
    for (const token of [ada, bob]) {
      const res = await get(token);
      expect(res.status).toBe(200);
      const rest = ((await res.json()) as any).items as any[];
      expect(rest).toEqual((await mcpTool(servers.url, token, "now")).value);
      expect(rest.map((r) => r.run)).toContain(openRun);
    }
    const seen = (((await (await get(bob)).json()) as any).items as any[]).map((r) => r.run);
    expect(seen).not.toContain(sealedRun);
    const row = (((await (await get(bob)).json()) as any).items as any[]).find((r) => r.run === openRun);
    expect(row).toMatchObject({ app: "ada/hello", on: "#1 open work", why: "work", state: "queued" });
  });

  test("a run on a private app is hidden from one who may not enter it", async () => {
    const seen = (((await (await get(bob)).json()) as any).items as any[]).map((r) => r.run);
    expect(seen).not.toContain(privateRun);
    const mine = (((await (await get(ada)).json()) as any).items as any[]).map((r) => r.run);
    expect(mine).toContain(privateRun);
  });

  test("a declined planner waits for the owner, not for a stranger", async () => {
    const waits = async (token: string) =>
      (((await (await get(token)).json()) as any).items as any[]).filter((r) => r.run === null);
    expect(await waits(ada)).toMatchObject([
      { app: "ada/hello", who: "the planner", why: "declined", says: "too vague", state: "waiting for you" },
    ]);
    expect(await waits(bob)).toEqual([]);
  });

  test("the author of the sealed report sees its run", async () => {
    const rest = ((await (await get(ada)).json()) as any).items as any[];
    expect(rest.map((r) => r.run)).toContain(sealedRun);
  });

  test("openapi lists the route", async () => {
    const doc = (await (await adminOpenapi(app, servers.url, "/api/v1/openapi.json")).json()) as any;
    expect(doc.paths["/api/v1/crew/now"].get).toBeDefined();
  });
});
