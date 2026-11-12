/**
 * The `issue` tool answers `blockedBy` and `blocks` as the REST read does,
 * and leaves out an issue the caller cannot see (a sealed one).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue } from "../src/core/issues.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP issue dependencies", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceTok: string;
  let bobTok: string;
  let id = 1;
  const no: Record<"a" | "b" | "c" | "s" | "t", number> = { a: 0, b: 0, c: 0, s: 0, t: 0 };

  const tool = async (token: string, number: number) => {
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
        params: { name: "issue", arguments: { repo: "alice/game", number } },
      }),
    });
    const body: any = await res.json();
    return JSON.parse(body.result.content[0].text);
  };
  const pairs = (xs: any[]) => xs.map((x) => ({ number: x.number, title: x.title }));

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-issue-deps-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    aliceTok = createToken(app.db, a.value.id, "ro", "ro").token;
    bobTok = createToken(app.db, b.value.id, "ro", "ro").token;
    const repo = await createRepo(app, a.value, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const mk = (title: string, sealed = false) => {
      const r = createIssue(app.db, { repoId: repo.value.id, authorId: a.value.id, title, sealed });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const A = mk("Issue A"), B = mk("Issue B"), C = mk("Issue C");
    const S = mk("Sealed blocker", true), T = mk("Sealed dependant", true);
    no.a = A.number; no.b = B.number; no.c = C.number; no.s = S.number; no.t = T.number;
    for (const [i, bl] of [[A, B], [C, A], [A, S], [T, A]] as const) {
      const r = addDependency(app.db, i, bl, a.value.id);
      if (!r.ok) throw new Error(r.error);
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("blockedBy and blocks name the pairs the REST read returns", async () => {
    const r = await tool(bobTok, no.a);
    expect(pairs(r.blockedBy)).toEqual([{ number: no.b, title: "Issue B" }]);
    expect(pairs(r.blocks)).toEqual([{ number: no.c, title: "Issue C" }]);
    const res = await fetch(`${servers.url}/api/v1/repos/alice/game/issues/${no.a}/dependencies`, {
      headers: { authorization: `Bearer ${bobTok}` },
    });
    const rest: any = await res.json();
    expect(pairs(rest.blockedBy)).toEqual(pairs(r.blockedBy));
    expect(pairs(rest.blocks)).toEqual(pairs(r.blocks));
  });

  test("a sealed blocker the caller cannot see is left out of blockedBy", async () => {
    const r = await tool(bobTok, no.a);
    expect(r.blockedBy.map((x: any) => x.number)).not.toContain(no.s);
    expect(JSON.stringify(r)).not.toContain("Sealed blocker");
    const own = await tool(aliceTok, no.a);
    expect(own.blockedBy.map((x: any) => x.number)).toEqual([no.b, no.s]);
  });

  test("a sealed dependant the caller cannot see is left out of blocks", async () => {
    const r = await tool(bobTok, no.a);
    expect(r.blocks.map((x: any) => x.number)).not.toContain(no.t);
    expect(JSON.stringify(r)).not.toContain("Sealed dependant");
    const own = await tool(aliceTok, no.a);
    expect(own.blocks.map((x: any) => x.number)).toEqual([no.c, no.t]);
  });
});
