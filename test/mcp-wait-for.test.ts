/**
 * The `wait_for` tool is the issue page's dependency action over MCP: a
 * writer's call works, a reader's is refused in the page's words, and bad
 * input is refused at the boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("wait_for over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let rw: string;
  let ro: string;
  let bobRw: string;
  let id = 1;

  const tool = async (token: string, name: string, args: unknown = {}) => {
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
        params: { name, arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };
  const tell = async (text: string): Promise<number> =>
    (await tool(rw, "tell", { repo: "alice/game", text })).value.issue;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-wait-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    rw = createToken(app.db, a.value.id, "rw", "rw").token;
    ro = createToken(app.db, a.value.id, "ro", "ro").token;
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    bobRw = createToken(app.db, b.value.id, "rw", "rw").token;
    const open = await createRepo(app, a.value, { name: "open", visibility: "public" });
    if (!open.ok) throw new Error(String(open.error));
    const made = await createRepo(app, a.value, { name: "game", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    const rec = insertApp(app.db, { repoId: made.value.id, slug: "game", access: "private" });
    if (!rec.ok) throw new Error(rec.error);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer makes an issue wait, then stop waiting", async () => {
    const a = await tell("first");
    const b = await tell("second");
    const set = await tool(rw, "wait_for", { app: "alice/game", issue: b, blockedBy: a });
    expect(set.value.says).toBe(`#${b} waits for #${a}.`);
    expect(set.value.url).toBe(`${servers.url}/alice/game/issues/${b}`);
    const map = (await tool(rw, "map", { app: "alice/game" })).value;
    expect(map.edges).toContainEqual({ issue: b, blockedBy: a });
    // The page's rule: no loops.
    expect(
      (await tool(rw, "wait_for", { app: "alice/game", issue: a, blockedBy: b })).error,
    ).toContain("loop");
    const stopped = await tool(rw, "wait_for", { app: "alice/game", issue: b, blockedBy: a, stop: true });
    expect(stopped.value.says).toBe(`#${b} no longer waits for #${a}.`);
    const after = (await tool(rw, "map", { app: "alice/game" })).value;
    expect(after.edges).not.toContainEqual({ issue: b, blockedBy: a });
  });

  test("a reader is refused, and nothing changes", async () => {
    const a = await tell("third");
    const b = await tell("fourth");
    const refused = await tool(ro, "wait_for", { app: "alice/game", issue: b, blockedBy: a });
    expect(refused.error).toContain("forbidden");
    const unchanged = (await tool(rw, "map", { app: "alice/game" })).value;
    expect(unchanged.edges).not.toContainEqual({ issue: b, blockedBy: a });
    // A signed-in stranger on a public app is refused in the page's words.
    const a2 = (await tool(rw, "tell", { repo: "alice/open", text: "x" })).value.issue;
    const b2 = (await tool(rw, "tell", { repo: "alice/open", text: "y" })).value.issue;
    const stranger = await tool(bobRw, "wait_for", { app: "alice/open", issue: b2, blockedBy: a2 });
    expect(stranger.error).toBe("forbidden: You need write access, or a place on the crew, to plan here.");
    const map = (await tool(ro, "map", { app: "alice/game" })).value;
    expect(map.edges).not.toContainEqual({ issue: b, blockedBy: a });
  });

  test("bad input is refused at the boundary", async () => {
    const a = await tell("fifth");
    const w = (args: Record<string, unknown>) =>
      tool(rw, "wait_for", { app: "alice/game", ...args });
    expect((await w({ issue: a, blockedBy: a })).error).toContain("itself");
    expect((await w({ issue: a, blockedBy: 9999 })).error).toContain("no_such_issue");
    expect((await w({ issue: "1", blockedBy: a })).error).toContain("no_such_issue");
    expect((await w({ issue: a, blockedBy: a + 0.5 })).error).toContain("no_such_issue");
    expect((await w({ issue: a, blockedBy: 1, stop: "yes" })).error).toContain("invalid_stop");
    expect((await tool(rw, "wait_for", { issue: a, blockedBy: 1 })).error).toBeDefined();
  });
});
