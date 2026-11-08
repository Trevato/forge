/**
 * The `person` tool answers what /api/v1/users/:username and its /repos answer
 * the same caller: a stranger sees public repositories only, a team member the
 * private one they were given, and an unknown name is not found.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP person", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let aliceRo: string;
  let bobRo: string;
  let carolRo: string;
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
        params: { name: "person", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-person-"));
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
    const carol = await mk("carol");
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    carolRo = createToken(app.db, carol.id, "ro", "ro").token;
    const dave = await mk("dave");
    app.db.query("UPDATE user SET suspended_at = ? WHERE id = ?").run(new Date().toISOString(), dave.id);
    const org = createOrg(app.db, "guild", alice.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "makers", "read");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, bob.id);
    for (const [name, visibility] of [["open", "public"], ["hidden", "private"]] as const) {
      const made = await createRepo(app, alice, { name, visibility, owner: "guild" });
      if (!made.ok) throw new Error(String(made.error));
    }
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a stranger sees the profile and only public repositories", async () => {
    const r = await tool(carolRo, { username: "guild" });
    expect(r.value.username).toBe("guild");
    expect(r.value.repos.items.map((x: any) => x.name)).toEqual(["open"]);
  });

  test("a member also sees the private repository they were given", async () => {
    const r = await tool(bobRo, { username: "guild" });
    expect(r.value.repos.items.map((x: any) => x.name).sort()).toEqual(["hidden", "open"]);
  });

  test("limit pages with a cursor", async () => {
    const first = await tool(bobRo, { username: "guild", limit: 1 });
    expect(first.value.repos.items.length).toBe(1);
    const next = await tool(bobRo, { username: "guild", limit: 1, cursor: first.value.repos.next_cursor });
    expect(next.value.repos.items.length).toBe(1);
    expect(next.value.repos.items[0].name).not.toBe(first.value.repos.items[0].name);
  });

  test("a limit outside 1 to 200 is refused, 1 and 200 pass", async () => {
    for (const bad of [0, -5, 9999, 201, 1.5, "x"])
      expect((await tool(bobRo, { username: "guild", limit: bad })).error).toContain(
        "invalid_limit",
      );
    expect((await tool(bobRo, { username: "guild", limit: 1 })).value.repos.items).toHaveLength(1);
    expect((await tool(bobRo, { username: "guild", limit: 200 })).value).toBeDefined();
  });

  test("a suspended person is not found to a non-admin, and still found by an admin", async () => {
    expect((await tool(carolRo, { username: "dave" })).error).toContain("no such person");
    expect((await tool(aliceRo, { username: "dave" })).value.username).toBe("dave");
  });

  test("an unknown name is not found, and bad arguments are refused", async () => {
    expect((await tool(carolRo, { username: "nobody" })).error).toContain("no such person");
    expect((await tool(carolRo, {})).error).toBeDefined();
    expect((await tool(carolRo, { username: 5 })).error).toBeDefined();
  });
});
