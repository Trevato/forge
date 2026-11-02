/**
 * The `confirm_wait` tool is the API's confirm action over MCP: a writer
 * unparks an issue held by a dropped blocker; readers, strangers and the
 * crew are refused as the route refuses them; bad input is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addCrew, createAgentRow } from "../src/core/agents.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue } from "../src/core/issues.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listVia } from "./mcp-list.ts";

describe("confirm_wait over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: any;
  let rw: string;
  let ro: string;
  let bobRw: string;
  let crewTok: string;
  let id = 1;

  const post = async (token: string, method: string, params: unknown) => {
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
  const tool = async (token: string, name: string, args: unknown = {}) => {
    const body = await post(token, "tools/call", { name, arguments: args });
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };
  const tell = async (text: string): Promise<number> =>
    (await tool(rw, "tell", { repo: "alice/game", text })).value.issue;
  /** An issue waiting on a blocker that closed dropped. */
  const parked = async () => {
    const blocker = await tell("plan");
    const waiter = await tell("built on it");
    addDependency(
      app.db,
      getIssue(app.db, repo.id, waiter)!,
      getIssue(app.db, repo.id, blocker)!,
      alice.id,
    );
    const closed = setIssueState(app, alice, repo, getIssue(app.db, repo.id, blocker)!, "closed", {
      reason: "dropped",
    });
    if (!closed.ok) throw new Error(String(closed.error));
    return { blocker, waiter };
  };
  const parkedBecause = async (waiter: number) =>
    (await tool(rw, "map", { app: "alice/game" })).value.issues.find(
      (i: any) => i.number === waiter,
    ).parkedBecause;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-confirm-"));
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
    alice = a.value;
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
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
    const bot = await createUser(app.db, {
      username: "botty",
      email: "botty@forge.test",
      agent: true,
      origin: "agent",
    });
    if (!bot.ok) throw new Error(bot.error);
    createAgentRow(app.db, { userId: bot.value.id, brief: "botty." });
    crewTok = createToken(app.db, bot.value.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const rec = insertApp(app.db, { repoId: repo.id, slug: "game", access: "private" });
    if (!rec.ok) throw new Error(rec.error);
    addCrew(app.db, repo.id, bot.value.id, alice.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is listed with a schema", async () => {
    const listed = await listVia((p) => post(rw, "tools/list", p));
    const t = listed.result.tools.find((x: any) => x.name === "confirm_wait");
    expect(t.inputSchema.required).toEqual(["app", "issue", "blocker"]);
  });

  test("a writer confirms and the map no longer shows it parked", async () => {
    const { blocker, waiter } = await parked();
    expect(await parkedBecause(waiter)).toBe(`#${blocker} was dropped`);
    const done = await tool(rw, "confirm_wait", { app: "alice/game", issue: waiter, blocker });
    expect(done.value.says).toBe(`#${waiter} may go ahead without #${blocker}.`);
    expect(await parkedBecause(waiter)).toBeUndefined();
  });

  test("a reader, a stranger and the crew are refused, and nothing changes", async () => {
    const { blocker, waiter } = await parked();
    const args = { app: "alice/game", issue: waiter, blocker };
    expect((await tool(ro, "confirm_wait", args)).error).toContain("forbidden");
    expect((await tool(bobRw, "confirm_wait", args)).error).toBeDefined();
    expect((await tool(crewTok, "confirm_wait", args)).error).toContain("forbidden");
    expect(await parkedBecause(waiter)).toBe(`#${blocker} was dropped`);
  });

  test("bad input is refused at the boundary", async () => {
    const w = (args: Record<string, unknown>) =>
      tool(rw, "confirm_wait", { app: "alice/game", ...args });
    expect((await w({ issue: 1, blocker: 9999 })).error).toContain("no_such_issue");
    expect((await w({ issue: "1", blocker: 1 })).error).toContain("no_such_issue");
    expect((await w({ issue: 1, blocker: 1.5 })).error).toContain("no_such_issue");
    expect((await tool(rw, "confirm_wait", { issue: 1, blocker: 1 })).error).toBeDefined();
  });
});
