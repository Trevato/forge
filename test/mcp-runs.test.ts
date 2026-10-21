/**
 * The `runs` tool lists a repository's recent runs through the same gate as
 * GET …/runs: a list, a private repository as not found, a bad limit refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { createRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP runs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
  let bobRo: string;
  let number: number;
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
        params: { name: "runs", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-runs-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice");
    const bob = await mk("bob");
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    const made = await createRepo(app, alice, { name: "vault", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = made.value.id;
    const issue = createIssue(app.db, { repoId, authorId: alice.id, title: "Build it" });
    if (!issue.ok) throw new Error(issue.error);
    number = issue.value.number;
    createRun(app.db, { repoId, kind: "agent", issueId: issue.value.id, actorId: alice.id, reason: "assigned" });
    createRun(app.db, { repoId, kind: "deploy", env: "production", reason: "push" });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("lists runs newest first with the issue number", async () => {
    const r = await tool(aliceRo, { repo: "alice/vault" });
    expect(r.value.runs.map((x: any) => x.kind)).toEqual(["deploy", "agent"]);
    expect(r.value.runs[1].number).toBe(number);
    expect(r.value.runs[0].number).toBeNull();
    expect(Object.keys(r.value.runs[0]).sort()).toEqual(
      ["endedAt", "id", "kind", "number", "startedAt", "state"],
    );
    expect((await tool(aliceRo, { repo: "alice/vault", limit: 1 })).value.runs).toHaveLength(1);
  });

  test("a private repository without access is not found", async () => {
    const r = await tool(bobRo, { repo: "alice/vault" });
    expect(r.error).toContain("no such app or repository");
  });

  test("a bad limit is refused", async () => {
    for (const limit of [0, 51, 1.5, "9"])
      expect((await tool(aliceRo, { repo: "alice/vault", limit })).error).toContain("limit");
  });
});
