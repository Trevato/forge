/**
 * `seal` with `action: "private"` is POST …/issues/:number/private over MCP: the same
 * action, so the same rules, and the clone URL comes from the forge's origin.
 */
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
import { listVia } from "./mcp-list.ts";

describe("MCP seal action private", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let bob: string;
  let carol: string;
  let sealedNo: number;
  let openNo: number;
  let id = 1;

  const rpc = async (token: string, method: string, params?: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
    });
    return (await res.json()) as any;
  };
  const tool = async (token: string, args: unknown) => {
    const body = await rpc(token, "tools/call", { name: "seal", arguments: { action: "private", ...(args as object) } });
    const text: string = body.result.content[0].text;
    return { text, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-private-fix-"));
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
    const a = await mk("alice", true);
    const b = await mk("bob");
    const c = await mk("carol");
    alice = createToken(app.db, a.id, "rw", "rw").token;
    bob = createToken(app.db, b.id, "rw", "rw").token;
    carol = createToken(app.db, c.id, "rw", "rw").token;
    const repo = await createRepo(app, a, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    const sealed = createIssue(app.db, { repoId: repo.value.id, authorId: a.id, title: "Embargoed", sealed: true });
    const open = createIssue(app.db, { repoId: repo.value.id, authorId: a.id, title: "Open" });
    if (!sealed.ok || !open.ok) throw new Error("issues");
    sealedNo = sealed.value.number;
    openNo = open.value.number;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("seal takes the private action in its schema", async () => {
    const listed = await listVia((p) => rpc(alice, "tools/list", p));
    const t = listed.result.tools.find((x: any) => x.name === "seal");
    expect(t.inputSchema.properties.action.enum).toEqual(["private"]);
    expect(listed.result.tools.some((x: any) => x.name === "private_fix")).toBe(false);
  });

  test("a writer gets the private repository, cloned from the forge's origin", async () => {
    const r = await tool(alice, { repo: "alice/game", number: sealedNo });
    expect(r.isError).toBe(false);
    const body = JSON.parse(r.text);
    expect(body.repo).toMatch(/^alice\/.+/);
    expect(body.clone).toBe(`${servers.url}/${body.repo}.git`);
    expect(typeof body.says).toBe("string");
    const again = JSON.parse((await tool(alice, { repo: "alice/game", number: sealedNo })).text);
    expect(again.repo).toBe(body.repo);
  });

  test("a reader and a stranger are refused as the route refuses them", async () => {
    for (const t of [bob, carol]) {
      const r = await tool(t, { repo: "alice/game", number: sealedNo });
      expect(r.isError).toBe(true);
      expect(r.text).toContain("no_such_issue");
    }
  });

  test("an issue that is not sealed is refused in the route's words", async () => {
    const r = await tool(alice, { repo: "alice/game", number: openNo });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("not_sealed");
  });

  test("a bad argument is a refusal, not a throw", async () => {
    for (const args of [
      {},
      { repo: "alice/game" },
      { repo: "alice/game", number: "1" },
      { repo: "alice/game", number: -1 },
      { repo: "alice/game", number: 1.5 },
      { repo: 7, number: 1 },
      { repo: "alice/game", number: 9999 },
    ]) {
      const r = await tool(alice, args);
      expect(r.isError).toBe(true);
    }
  });
});
