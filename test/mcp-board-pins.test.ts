/** The `board_pins` tool lists, pins and unpins as GET/POST /api/v1/boards/pins do, and refuses agents and non-admins. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { writeBoard } from "../src/actions/boards.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const panel = (title: string) => ({ title, chart: "line", query: { source: "runs", aggregate: "count", groupBy: "kind" }, w: 1, h: 1 });

describe("MCP board_pins", () => {
  let dir: string;
  let app: App;
  let servers: Servers;
  const tok: Record<string, string> = {};

  const tool = async (who: string, args: Record<string, unknown>) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tok[who]}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_pins", arguments: args } }),
    });
    const body: any = await res.json();
    return { isError: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const api = async (who: string) => {
    const res = await fetch(`${servers.url}/api/v1/boards/pins`, { headers: { authorization: `Bearer ${tok[who]}` } });
    return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : undefined };
  };
  const apiPairs = async () => (await api("alice")).body.pins.map((p: any) => ({ slug: p.slug, title: p.title }));

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-mcp-board-pins-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst?: boolean): Promise<User> => {
      const r = await createUser(app.db, {
        origin: "seed", trusted: true, username, email: `${username}@forge.local`,
        password: "a-good-passphrase", ...(adminIfFirst ? { adminIfFirst } : {}),
      });
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const alice = await mk("alice", true);
    const bob = await mk("bob");
    const made = await createAgent(app, alice, { username: "scout", brief: "b", model: "m" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [made.value.user.id]);
    tok.alice = createToken(app.db, alice.id, "t", "admin").token;
    tok.bob = createToken(app.db, bob.id, "t", "admin").token;
    tok.scout = createToken(app.db, made.value.user.id, "t", "admin").token;
    const w = await writeBoard(app, alice, "mine", { title: "Mine", range: "all", refresh: "off", panels: [panel("Pin A"), panel("Pin B")] });
    if (!w.ok) throw new Error(JSON.stringify(w.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("with no op a person admin lists the same pins as the API, and pin and unpin show there", async () => {
    let r = await tool("alice", {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual({ pins: [] });
    expect(await apiPairs()).toEqual([]);

    r = await tool("alice", { op: "pin", slug: "mine", title: "Pin A" });
    expect(r.isError).toBe(false);
    await tool("alice", { op: "pin", slug: "mine", title: "Pin B" });
    const listed = JSON.parse((await tool("alice", {})).text);
    expect(listed.pins).toEqual([{ slug: "mine", title: "Pin A" }, { slug: "mine", title: "Pin B" }]);
    expect(await apiPairs()).toEqual(listed.pins);

    r = await tool("alice", { op: "unpin", slug: "mine", title: "Pin A" });
    expect(r.isError).toBe(false);
    expect(await apiPairs()).toEqual([{ slug: "mine", title: "Pin B" }]);
    expect(JSON.parse((await tool("alice", {})).text).pins).toEqual(await apiPairs());
  });

  test("pinning a panel that does not exist is refused and the list is unchanged", async () => {
    const before = await apiPairs();
    for (const args of [{ slug: "mine", title: "Nope" }, { slug: "ghost", title: "Pin A" }]) {
      const r = await tool("alice", { op: "pin", ...args });
      expect(r.isError).toBe(true);
    }
    expect(await apiPairs()).toEqual(before);
    expect(JSON.parse((await tool("alice", {})).text).pins).toEqual(before);
  });

  test("an agent and a non-admin are refused, and pin nothing", async () => {
    for (const who of ["scout", "bob"]) {
      expect((await tool(who, {})).isError).toBe(true);
      expect((await tool(who, { op: "pin", slug: "mine", title: "Pin A" })).isError).toBe(true);
    }
    expect((await api("scout")).status).toBe(403);
    expect(await apiPairs()).toEqual([{ slug: "mine", title: "Pin B" }]);
  });
});
