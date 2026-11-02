/** The `orgs` tool reads the organizations API over MCP: yours, and one with the teams you may see. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP orgs", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: string;
  let member: string;
  let stranger: string;
  let id = 1;

  const tool = async (token: string, args: unknown, name = "orgs") => {
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
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-orgs-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice");
    const b = await mk("bob");
    const c = await mk("carol");
    owner = createToken(app.db, a.id, "admin", "admin").token;
    member = createToken(app.db, b.id, "admin", "admin").token;
    stranger = createToken(app.db, c.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", a.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "docs", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, b.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the caller's organizations", async () => {
    const mine = await tool(member, {});
    expect(JSON.parse(mine.text).map((o: any) => o.username)).toEqual(["acme"]);
    expect(JSON.parse((await tool(stranger, {})).text)).toEqual([]);
  });

  test("one organization with a team and its member", async () => {
    const got = await tool(owner, { org: "acme" });
    expect(got.isError).toBe(false);
    const org = JSON.parse(got.text);
    expect(org.username).toBe("acme");
    expect(org.teams.map((t: any) => t.name)).toEqual(["Owners", "docs"]);
    expect(org.teams[1].members.map((m: any) => m.username)).toEqual(["bob"]);
  });

  test("a stranger sees no team, and an unknown organization is not found", async () => {
    const got = await tool(stranger, { org: "acme" });
    expect(JSON.parse(got.text).teams).toEqual([]);
    expect((await tool(owner, { org: "nope" })).isError).toBe(true);
    expect((await tool(owner, { org: 7 })).isError).toBe(true);
  });

  test("org_create makes an organization that orgs then reads back", async () => {
    const made = await tool(stranger, { name: "newco" }, "org_create");
    expect(made.isError).toBe(false);
    expect(JSON.parse(made.text).username).toBe("newco");
    const got = await tool(stranger, { org: "newco" });
    expect(JSON.parse(got.text).teams.map((t: any) => t.name)).toEqual(["Owners"]);
    expect(JSON.parse((await tool(stranger, {})).text).map((o: any) => o.username)).toEqual(["newco"]);
  });

  test("org_create refuses a taken name and an invalid one", async () => {
    expect((await tool(owner, { name: "acme" }, "org_create")).isError).toBe(true);
    expect((await tool(owner, { name: "not valid!" }, "org_create")).isError).toBe(true);
    expect((await tool(owner, {}, "org_create")).isError).toBe(true);
  });
});
