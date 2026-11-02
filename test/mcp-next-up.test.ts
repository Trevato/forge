/** `next_up` over MCP: the ranked list, and the same one-action moves as the page. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("next_up over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let rw: string;
  let ro: string;
  let id = 1;
  const numbers: number[] = [];

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "next_up", arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-next-up-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    const alice = made.value;
    const repo = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    insertApp(app.db, { repoId: repo.value.id, slug: "game", access: "private" });
    for (const title of ["One", "Two", "Three"]) {
      const o = openIssue(app, alice, repo.value, { title });
      if (!o.ok) throw new Error(String(o.error));
      numbers.push(o.value.number);
    }
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer moves an issue to the top and the list answers in the new order", async () => {
    const moved = await tool(rw, { app: "alice/game", issue: numbers[2], to: "top" });
    expect(moved.value.next[0].issue).toBe(numbers[2]);
    expect(moved.value.next[0].place).toBe(1);
  });

  test("a read-only token reads the list and cannot move", async () => {
    expect((await tool(ro, { app: "alice/game" })).value.next[0].issue).toBe(numbers[2]);
    expect((await tool(ro, { app: "alice/game", issue: numbers[0], to: "top" })).error).toBeDefined();
  });

  test("bad input is refused at the boundary", async () => {
    expect((await tool(rw, { app: "alice/game", issue: numbers[0], to: "sideways" })).error).toBeDefined();
    expect((await tool(rw, { app: "alice/game", issue: 9999, to: "top" })).error).toBeDefined();
  });
});
