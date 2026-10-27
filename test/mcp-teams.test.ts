/** The `teams` tool: a person admin plans, then changes, a team; anyone else is told there is no such tool. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { listTeams } from "../src/core/teams.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP teams", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let agentAdmin: string;
  let plain: string;
  let slug: string;
  let botId: string;
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
        params: { name: "teams", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text = body.result.content[0].text as string;
    return { text, isError: body.result.isError === true };
  };
  const team = () => listTeams(app.db).find((t) => t.slug === slug)!;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-teams-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const alice = await mk("alice");
    const bob = await mk("bob");
    app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [alice.id]);
    app.db.run("UPDATE user SET is_admin = 0 WHERE id = ?", [bob.id]);
    const bot = await createAgent(app, { ...alice, isAdmin: true }, { username: "bot" });
    if (!bot.ok) throw new Error(bot.error);
    botId = bot.value.user.id;
    app.db.run("UPDATE user SET is_admin = 1 WHERE id = ?", [botId]);
    admin = createToken(app.db, alice.id, "admin", "admin").token;
    plain = createToken(app.db, bob.id, "admin", "admin").token;
    agentAdmin = createToken(app.db, botId, "admin", "admin").token;
    slug = listTeams(app.db)[0]!.slug;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("without a slug it lists the teams", async () => {
    const r = await tool(admin, {});
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text).teams.map((t: any) => t.slug)).toContain(slug);
  });

  test("a dial is planned by default, changes nothing, and applies with dryRun false", async () => {
    const before = team();
    const plan = await tool(admin, { slug, dial: 7 });
    expect(plan.isError).toBe(false);
    expect(plan.text).toContain("Would change");
    expect(team()).toEqual(before);
    const said = await tool(admin, { slug, dial: 7, dryRun: true });
    expect(said.isError).toBe(false);
    expect(team().dial).toBe(before.dial);

    const done = await tool(admin, { slug, dial: 7, charter: "Ship small.", members: [botId], dryRun: false });
    expect(done.isError).toBe(false);
    expect(team().dial).toBe(7);
    expect(team().charter).toBe("Ship small.");
    expect(team().members).toEqual([botId]);
  });

  test("a malformed change is refused, planned or applied, and the team is unchanged", async () => {
    const before = team();
    const bads: Record<string, unknown>[] = [
      { dial: "50" },
      { dial: 101 },
      { dial: -1 },
      { dial: 1.5 },
      { members: "bot" },
      { members: [1, 2] },
      { members: ["nobody"] },
      { charter: 5 },
    ];
    for (const change of bads)
      for (const dryRun of [true, false]) {
        const r = await tool(admin, { slug, ...change, dryRun });
        expect(r.isError).toBe(true);
        expect(team()).toEqual(before);
      }
    expect((await tool(admin, { slug, dial: "50" })).text).toContain("invalid_body");
    expect((await tool(admin, { slug: "nope", dial: 5 })).isError).toBe(true);
  });

  test("an agent admin and a non-admin are refused, and nothing changes", async () => {
    const before = team();
    for (const token of [agentAdmin, plain]) {
      expect((await tool(token, {})).isError).toBe(true);
      expect((await tool(token, { slug, dial: 3 })).isError).toBe(true);
      expect((await tool(token, { slug, dial: 3, dryRun: false })).isError).toBe(true);
    }
    expect(team()).toEqual(before);
  });
});
