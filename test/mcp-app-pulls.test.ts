/**
 * `GET …/app/pulls` and MCP `apps` (#10102): an adapter's recorded pull runs, newest first,
 * for readers of the repository; a stranger to a private repository gets 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { recordPull } from "../src/apps/pull.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { promote } from "./helpers/members.ts";
import { tokenFor } from "./helpers/tokens.ts";

describe("app pulls API", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
  let bobRo: string;

  const get = (path: string, token?: string) =>
    fetch(`${servers.url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : {});

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-app-pulls-api-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    await seedAdmin(app, { username: "alice", email: "alice@forge.local", password: "a-good-passphrase" });
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    const alice = getUserByName(app.db, "alice")!;
    for (const [name, visibility] of [["hello", "public"], ["secret", "private"]] as const) {
      const made = await newApp(app, alice, { name, visibility } as never);
      if (!made.ok) throw new Error(String(made.error));
      const repo = getRepo(app.db, "alice", name)!;
      const appId = (app.db.query("SELECT id FROM app WHERE repo_id = ?1").get(repo.id) as { id: string }).id;
      recordPull(app.db, appId, { ok: true, pulled: 3, skipped: 1, errors: 0, cursor: "c1", durationMs: 42 });
      recordPull(app.db, appId, { ok: false, reason: "status 500 is not 2xx", durationMs: 7 });
    }
    aliceRo = tokenFor(app, "alice", "ro");
    bobRo = tokenFor(app, "bob", "ro");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const mcp = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "apps", arguments: args } }),
    });
    const r: any = ((await res.json()) as any).result;
    const text: string = r.content[0].text;
    return r.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  test("MCP answers the same rows as the API, through the same read", async () => {
    const api: any = await (await get("/api/v1/repos/alice/secret/app/pulls", aliceRo)).json();
    const m = await mcp(aliceRo, { repo: "alice/secret", pulls: true });
    expect(m.value).toEqual(api);
    expect(m.value.items[0]).toMatchObject({ state: "failed", error: "status 500 is not 2xx" });
    const one = await mcp(aliceRo, { repo: "alice/secret", pulls: true, limit: 1 });
    expect(one.value.items).toHaveLength(1);
    expect((await mcp(aliceRo, { repo: "alice/secret", pulls: true, limit: 101 })).error).toContain("limit");
  });

  test("MCP: a stranger and a missing app get not_found", async () => {
    expect((await mcp(bobRo, { repo: "alice/secret", pulls: true })).error).toContain("no such app");
    expect((await mcp(aliceRo, { repo: "alice/nothing", pulls: true })).error).toContain("no such app");
    expect((await mcp(bobRo, { repo: "alice/hello", pulls: true })).value.items).toHaveLength(2);
  });
});
