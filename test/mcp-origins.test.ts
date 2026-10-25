/**
 * The `origins` tool is the API's origin routes over MCP: the same actions,
 * for the caller only, and never a credential in an answer.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";

const LOGIN = "octo";
const TOKEN = "octo-origin-secret-9f3a";

describe("MCP origins", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let fake: FakeForge;
  let aliceAdmin: string;
  let aliceRw: string;
  let bobAdmin: string;
  let originId = "";
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
        params: { name: "origins", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text), text };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-origins-"));
    const state = newFakeState("github", LOGIN, TOKEN);
    state.repos.push({
      id: 5,
      fullName: "octo/sprockets",
      cloneUrl: "http://127.0.0.1:1/octo/sprockets.git",
      defaultBranch: "main",
    });
    fake = serveFakeForge(state);
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    aliceAdmin = createToken(app.db, a.value.id, "admin", "admin").token;
    aliceRw = createToken(app.db, a.value.id, "rw", "rw").token;
    bobAdmin = createToken(app.db, b.value.id, "admin", "admin").token;
    const res = await fetch(`${servers.url}/api/v1/user/origins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${aliceAdmin}`,
      },
      body: JSON.stringify({ host: fake.url, kind: "github", token: TOKEN }),
    });
    expect(res.status).toBe(201);
    originId = ((await res.json()) as { id: string }).id;
  });

  afterAll(async () => {
    fake.stop();
    await servers.stop();
    app.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists the caller's origin without its token", async () => {
    const r = await tool(aliceAdmin, { action: "list" });
    expect(r.value.map((o: any) => o.id)).toEqual([originId]);
    expect(r.value[0].login).toBe(LOGIN);
    expect(r.text).not.toContain(TOKEN);
  });

  test("lists its repositories and starts a sync", async () => {
    const repos = await tool(aliceAdmin, { action: "repos", id: originId });
    expect(repos.value.map((x: any) => x.fullName)).toEqual(["octo/sprockets"]);
    expect(repos.value[0].mirroredAs).toBeNull();
    expect(repos.text).not.toContain(TOKEN);
    const sync = await tool(aliceAdmin, { action: "sync", id: originId });
    expect(sync.value).toBeDefined();
    expect(sync.text).not.toContain(TOKEN);
  });

  test("another person sees nothing of it", async () => {
    expect((await tool(bobAdmin, { action: "list" })).value).toEqual([]);
    for (const action of ["repos", "sync"])
      expect((await tool(bobAdmin, { action, id: originId })).error).toContain(
        "not_found",
      );
  });

  test("an unknown id is not found; a missing id is invalid", async () => {
    expect(
      (await tool(aliceAdmin, { action: "repos", id: "nope" })).error,
    ).toContain("not_found");
    expect((await tool(aliceAdmin, { action: "sync" })).error).toContain("invalid");
    expect((await tool(aliceAdmin, { action: "x" })).error).toContain("bad_action");
  });

  test("a token short of admin is refused", async () => {
    expect((await tool(aliceRw, { action: "list" })).error).toContain("forbidden");
    expect(
      (await tool(aliceRw, { action: "sync", id: originId })).error,
    ).toContain("forbidden");
  });
});
