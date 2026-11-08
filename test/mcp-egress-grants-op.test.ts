/**
 * The `egress_grants` tool's `op` grant or revoke is a site admin's, never an
 * agent's (#7062): the API's list follows each step, an agent with an
 * admin-scope token and a repository admin who is no site admin are refused
 * with the grant unchanged, and a destination forge.json does not ask for is
 * refused and never stored.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { listEgressGrants } from "../src/core/egress_grants.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { promote } from "./helpers/members.ts";

quietLogs();

const ARM = "100.89.95.68:8101";
const OTHER = "100.89.95.68:8999";

describe("MCP egress_grants op", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repo: Repo;
  let adaToken = "";
  let cyToken = "";
  let botToken = "";
  let id = 1;

  const call = async (token: string, args: Record<string, unknown>) => {
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
        params: { name: "egress_grants", arguments: { repo: "cy/arm", ...args } },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };
  const listed = async () => {
    const res = await fetch(`${servers.url}/api/v1/repos/cy/arm/egress-grants`, {
      headers: { authorization: `Bearer ${adaToken}` },
    });
    const body = (await res.json()) as any;
    return (body.items as { destination: string; granted: boolean }[])
      .filter((r) => r.granted)
      .map((r) => r.destination);
  };
  const stored = () => listEgressGrants(app.db, repo.id).map((g) => g.destination);

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-egress-op-"));
    app = createApp({ dataDir, port: 0, host: "forge.test" });
    servers = await serve(app);
    const make = async (username: string, adminIfFirst = false): Promise<User> => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    const ada = await make("ada", true);
    const cy = await make("cy");
    promote(app.db, cy);
    const made = await createRepo(app, cy, { name: "arm", visibility: "public", description: "" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const committed = await commitToBranch(app, cy, repo, {
      message: "Ask for the arm",
      files: [
        {
          path: "forge.json",
          content: JSON.stringify({ app: { run: "bun run src/server.ts" }, egress: [ARM] }),
        },
      ],
    });
    if (!committed.ok) throw new Error(JSON.stringify(committed.error));
    const row = insertApp(app.db, { repoId: repo.id, slug: "arm", access: "public" });
    if (!row.ok) throw new Error(row.error);
    // An agent that is a site admin still may not change grants.
    const bot = await createAgent(app, ada, { username: "botty", brief: "b", model: "m" });
    if (!bot.ok) throw new Error(String(bot.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(bot.value.user.id);
    adaToken = createToken(app.db, ada.id, "admin", "admin").token;
    cyToken = createToken(app.db, cy.id, "admin", "admin").token;
    botToken = createToken(app.db, bot.value.user.id, "admin", "admin").token;
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("a site admin grants what the app asks for, then revokes it; the API follows", async () => {
    expect(await listed()).toEqual([]);
    const granted = await call(adaToken, { op: "grant", destination: ARM });
    expect(granted.error).toBe(false);
    expect(JSON.parse(granted.text).granted).toBe(true);
    expect(await listed()).toEqual([ARM]);
    const revoked = await call(adaToken, { op: "revoke", destination: ARM });
    expect(revoked.error).toBe(false);
    expect(JSON.parse(revoked.text).revoked).toBe(ARM);
    expect(await listed()).toEqual([]);
  });

  test("an agent and a non-site-admin repository admin are refused, the grant unchanged", async () => {
    await call(adaToken, { op: "grant", destination: ARM });
    for (const token of [botToken, cyToken]) {
      for (const op of ["revoke", "grant"]) {
        const refused = await call(token, { op, destination: ARM });
        expect(refused.error).toBe(true);
      }
      expect(stored()).toEqual([ARM]);
    }
    expect(await listed()).toEqual([ARM]);
    await call(adaToken, { op: "revoke", destination: ARM });
    // Refused when nothing is granted too: no grant appears.
    for (const token of [botToken, cyToken]) {
      expect((await call(token, { op: "grant", destination: ARM })).error).toBe(true);
    }
    expect(stored()).toEqual([]);
  });

  test("a destination forge.json does not ask for is refused and never stored", async () => {
    const refused = await call(adaToken, { op: "grant", destination: OTHER });
    expect(refused.error).toBe(true);
    expect(refused.text).toContain("not_asked");
    expect(stored()).toEqual([]);
    expect(await listed()).toEqual([]);
  });
});
