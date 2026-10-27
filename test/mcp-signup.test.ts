/**
 * The `signup` tool (#7147): reading the mode is free for a site admin,
 * changing it plans first and applies only with an admin-scope token, an
 * unknown mode is `invalid_signup`, and a refused change leaves the mode.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { getSignup, setSignup } from "../src/settings/signup.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP signup", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let adminToken = "";
  let rwToken = "";
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
        params: { name: "signup", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    if (body.error) return { text: body.error.message as string, error: true };
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };
  const join_ = (username: string) =>
    fetch(`${servers.url}/api/v1/users`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: servers.url },
      body: JSON.stringify({ username, password: "a-long-passphrase" }),
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-signup-"));
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
    adminToken = createToken(app.db, ada.id, "admin", "admin").token;
    rwToken = createToken(app.db, ada.id, "rw", "rw").token;
    cyToken = createToken(app.db, cy.id, "admin", "admin").token;
    const bot = await createAgent(app, ada, { username: "botty", brief: "b", model: "m" });
    if (!bot.ok) throw new Error(String(bot.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(bot.value.user.id);
    botToken = createToken(app.db, bot.value.user.id, "admin", "admin").token;
    setSignup(app.db, "open", "system");
  }, 60_000);

  afterAll(async () => {
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  test("without a mode, an admin reads the current mode", async () => {
    const read = await call(adminToken, {});
    expect(read.error).toBe(false);
    expect(JSON.parse(read.text).signup).toBe("open");
  });

  test("a mode plans by default and changes nothing; dryRun false applies and closes the door", async () => {
    const plan = await call(adminToken, { mode: "closed" });
    expect(plan.error).toBe(false);
    expect(JSON.parse(plan.text).says).toContain("Would set signup from open to closed");
    expect(getSignup(app.db)).toBe("open");

    const planRw = await call(rwToken, { mode: "closed", dryRun: true });
    expect(planRw.error).toBe(false);
    expect(getSignup(app.db)).toBe("open");

    const applied = await call(adminToken, { mode: "closed", dryRun: false });
    expect(applied.error).toBe(false);
    expect(JSON.parse(applied.text).signup).toBe("closed");
    expect(getSignup(app.db)).toBe("closed");

    const refused = await join_("newbie");
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: string }).error).toBe("signup_closed");
    expect(getUserByName(app.db, "newbie")).toBeUndefined();
    setSignup(app.db, "open", "system");
  });

  test("an unknown mode is invalid_signup", async () => {
    for (const mode of ["public", 3, ""]) {
      const res = await call(adminToken, { mode, dryRun: false });
      expect(res.error).toBe(true);
      expect(res.text).toContain("invalid_signup");
    }
    expect(getSignup(app.db)).toBe("open");
  });

  test("an rw token, a non-admin and an agent cannot apply; the mode is unchanged", async () => {
    const rw = await call(rwToken, { mode: "closed", dryRun: false });
    expect(rw.error).toBe(true);
    expect(rw.text).toContain("forbidden");
    for (const token of [cyToken, botToken]) {
      const res = await call(token, { mode: "closed", dryRun: false });
      expect(res.error).toBe(true);
    }
    expect(getSignup(app.db)).toBe("open");
  });
});
