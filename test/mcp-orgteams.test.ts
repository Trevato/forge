/** The `org_teams` tool is the org-teams API over MCP: an owner arranges teams, no one else does. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrg } from "../src/core/orgs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP org_teams", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let owner: string;
  let member: string;
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
        params: { name: "org_teams", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-orgteams-"));
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
    await mk("carol");
    owner = createToken(app.db, a.id, "admin", "admin").token;
    member = createToken(app.db, b.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", a.id);
    if (!org.ok) throw new Error(org.error);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an owner creates a team, adds a member and removes the team", async () => {
    const made = await tool(owner, { org: "acme", action: "create", team: "docs", permission: "write" });
    expect(made.isError).toBe(false);
    expect(JSON.parse(made.text).name).toBe("docs");
    const added = await tool(owner, { org: "acme", action: "add_member", team: "docs", user: "carol" });
    expect(added.isError).toBe(false);
    expect(JSON.parse(added.text).added).toBe(true);
    const gone = await tool(owner, { org: "acme", action: "remove", team: "docs" });
    expect(gone.isError).toBe(false);
    const again = await tool(owner, { org: "acme", action: "remove", team: "docs" });
    expect(again.isError).toBe(true);
  });

  test("a taken team name is refused", async () => {
    await tool(owner, { org: "acme", action: "create", team: "ops" });
    const dup = await tool(owner, { org: "acme", action: "create", team: "ops" });
    expect(dup.isError).toBe(true);
  });

  test("someone who is not an owner is refused, and nothing changes", async () => {
    const made = await tool(member, { org: "acme", action: "create", team: "sneaky" });
    expect(made.isError).toBe(true);
    const gone = await tool(member, { org: "acme", action: "remove", team: "ops" });
    expect(gone.isError).toBe(true);
    const still = await tool(owner, { org: "acme", action: "add_member", team: "ops", user: "carol" });
    expect(still.isError).toBe(false);
    const unknown = await tool(owner, { org: "acme", action: "peek", team: "ops" });
    expect(unknown.isError).toBe(true);
  });

  test("remove_member takes one role off, then the member", async () => {
    await tool(owner, { org: "acme", action: "create", team: "crew", permission: "write" });
    await tool(owner, { org: "acme", action: "add_member", team: "crew", user: "carol", role: "reviewer" });
    const bad = await tool(owner, { org: "acme", action: "remove_member", team: "crew", user: "carol", role: "boss" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("bad_role");
    const off = await tool(owner, { org: "acme", action: "remove_member", team: "crew", user: "carol", role: "reviewer" });
    expect(off.isError).toBe(false);
    const kept = JSON.parse((await tool(owner, { org: "acme", action: "members", team: "crew" })).text);
    expect(kept).toEqual([{ user: "carol", role: "member" }]);
    const gone = await tool(owner, { org: "acme", action: "remove_member", team: "crew", user: "carol" });
    expect(gone.isError).toBe(false);
    expect(JSON.parse((await tool(owner, { org: "acme", action: "members", team: "crew" })).text)).toEqual([]);
    const none = await tool(owner, { org: "acme", action: "remove_member", team: "crew", user: "carol" });
    expect(none.isError).toBe(true);
    const denied = await tool(member, { org: "acme", action: "remove_member", team: "crew", user: "carol" });
    expect(denied.isError).toBe(true);
  });
});
