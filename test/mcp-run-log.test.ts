/** The `run_log` tool answers what GET …/runs/:id/log would, to the same callers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { appendRunLog } from "../src/runs/log.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP run_log", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
  let bobRo: string;
  let runId: string;
  let openRunId: string;
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
        params: { name: "run_log", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-run-log-"));
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
    const made = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    runId = createRun(app.db, { repoId: made.value.id, kind: "agent", actorId: alice.id, reason: "assigned" }).id;
    for (const line of ["one", "two", "three", "four"]) appendRunLog(dataDir, runId, line);
    const open = await createRepo(app, alice, { name: "square", visibility: "public" });
    if (!open.ok) throw new Error(String(open.error));
    openRunId = createRun(app.db, { repoId: open.value.id, kind: "agent", actorId: alice.id, reason: "assigned" }).id;
    appendRunLog(dataDir, openRunId, "secret-line");
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the owner reads the log, or its last lines", async () => {
    const all = await tool(aliceRo, { repo: "alice/vault", run: runId });
    expect(all.value.lines).toEqual(["one", "two", "three", "four"]);
    const tail = await tool(aliceRo, { repo: "alice/vault", run: runId, tail: 2 });
    expect(tail.value.lines).toEqual(["three", "four"]);
    expect(tail.value.truncated).toBe(true);
  });

  test("a caller who cannot read a private repository is told it is not found", async () => {
    const r = await tool(bobRo, { repo: "alice/vault", run: runId });
    expect(r.error).toContain("no such app or repository");
    expect(JSON.stringify(r)).not.toContain("three");
  });

  test("a reader of a public repository who is not crew cannot read the log", async () => {
    const r = await tool(bobRo, { repo: "alice/square", run: openRunId });
    expect(r.error).toContain("no such run here");
    expect(JSON.stringify(r)).not.toContain("secret-line");
    const owner = await tool(aliceRo, { repo: "alice/square", run: openRunId });
    expect(owner.value.lines).toEqual(["secret-line"]);
  });

  test("an unknown run is not found", async () => {
    const r = await tool(aliceRo, { repo: "alice/vault", run: "nope" });
    expect(r.error).toContain("no such run here");
  });

  test("a bad argument is refused", async () => {
    for (const bad of [{ tail: 0 }, { tail: 2001 }, { tail: 1.5 }, { tail: "2" }, { run: 5 }, { run: "" }]) {
      const r = await tool(aliceRo, { repo: "alice/vault", run: runId, ...bad });
      expect(r.error).toBeDefined();
    }
  });
});
