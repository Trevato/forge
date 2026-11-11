/** The `repo_settings` tool is PATCH /api/v1/repos/:owner/:name over MCP, for the same callers. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addTeamMember, createOrg, createTeam } from "../src/core/orgs.ts";
import { createRepo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP repo_settings", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let writer: string;
  let id = 1;

  const call = async (token: string, name: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-reposet-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true,
        username, email: `${username}@forge.local`, password: "a-good-passphrase",
        adminIfFirst: username === "alice" });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice");
    const b = await mk("bob");
    promote(app.db, a, b);
    admin = createToken(app.db, a.id, "admin", "admin").token;
    writer = createToken(app.db, b.id, "admin", "admin").token;
    const org = createOrg(app.db, "acme", a.id);
    if (!org.ok) throw new Error(org.error);
    const team = createTeam(app.db, org.value.id, "Writers", "write");
    if (!team.ok) throw new Error(team.error);
    addTeamMember(app.db, team.value, b.id);
    const made = await createRepo(app.db, app.reposRoot, {
      ownerId: org.value.id, name: "game", visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an admin changes description and visibility and reads them back", async () => {
    const set = await call(admin, "repo_settings", {
      repo: "acme/game", description: "tidy", visibility: "private",
    });
    expect(set.isError).toBe(false);
    expect(JSON.parse(set.text)).toMatchObject({ description: "tidy", visibility: "private" });
    const read = JSON.parse((await call(admin, "repo", { repo: "acme/game" })).text);
    expect(read).toMatchObject({ description: "tidy", visibility: "private" });
  });

  test("a writer who is not admin is refused", async () => {
    const set = await call(writer, "repo_settings", { repo: "acme/game", description: "mine" });
    expect(set.isError).toBe(true);
    const read = JSON.parse((await call(admin, "repo", { repo: "acme/game" })).text);
    expect(read.description).toBe("tidy");
  });

  test("an invalid visibility is refused", async () => {
    const set = await call(admin, "repo_settings", { repo: "acme/game", visibility: "secret" });
    expect(set.isError).toBe(true);
    expect(set.text).toContain("visibility is public or private");
  });

  test("newOwner moves a repository; a non-admin and a missing owner are refused", async () => {
    const miss = await call(admin, "repo_settings", { repo: "acme/game", newOwner: "nobody-here" });
    expect(miss.isError).toBe(true);
    expect(miss.text).toContain("unknown_owner");
    const denied = await call(writer, "repo_settings", { repo: "acme/game", newOwner: "bob" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("not_found");
    const moved = await call(admin, "repo_settings", { repo: "acme/game", newOwner: "alice" });
    expect(moved.isError).toBe(false);
    expect(JSON.parse(moved.text).repo).toBe("alice/game");
    const read = await call(admin, "repo", { repo: "alice/game" });
    expect(JSON.parse(read.text)).toMatchObject({ visibility: "private" });
    const again = await call(admin, "repo_settings", { repo: "alice/game", newOwner: "alice" });
    expect(again.text).toContain("same_owner");
  });
});
