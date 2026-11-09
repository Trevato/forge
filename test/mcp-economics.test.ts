/** MCP `economics`: the slider from a harness, under the API's rules. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { getEconomics } from "../src/settings/economics.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("MCP economics", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin = "";
  let adminRo = "";
  let bob = "";
  let adminRw = "";
  let agent = "";
  let id = 1;

  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "economics", arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { text: body.result.content[0].text as string, error: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-econ-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, adminIfFirst: boolean) => {
      const u = await createUser(app.db, {
        origin: "seed", username, email: `${username}@forge.local`,
        password: "a-good-passphrase", trusted: true, adminIfFirst,
      });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice", true);
    const b = await mk("bob", false);
    admin = createToken(app.db, a.id, "admin", "admin").token;
    adminRo = createToken(app.db, a.id, "ro", "ro").token;
    adminRw = createToken(app.db, a.id, "rw", "rw").token;
    const made = await createAgent(app, a, { username: "crew-a", budgetUsd: 1 });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    agent = createToken(app.db, made.value.user.id, "agent", "admin").token;
    bob = createToken(app.db, b.id, "admin", "admin").token;
  });
  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("with nothing it answers the position and the policy in words", async () => {
    const r = await call(adminRo, {});
    expect(r.error).toBe(false);
    const j = JSON.parse(r.text);
    expect(j.position).toBe(getEconomics(app.db).position);
    expect(typeof j.words).toBe("string");
    expect(j.policy).toBeDefined();
  });

  test("a position is planned first and changes nothing", async () => {
    const before = getEconomics(app.db).position;
    const r = await call(admin, { position: 70 });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text).to.position).toBe(70);
    expect(getEconomics(app.db).position).toBe(before);
    const badPlan = await call(admin, { position: 101 });
    expect(badPlan.error).toBe(true);
    expect(badPlan.text).toContain("position is a whole number from 0 to 100");
  });

  test("dryRun false sets it, and the read agrees", async () => {
    const r = await call(admin, { position: 70, marginPct: 15, dryRun: false });
    expect(r.error).toBe(false);
    expect(JSON.parse(r.text).position).toBe(70);
    expect(getEconomics(app.db)).toMatchObject({ position: 70, marginPct: 15 });
    expect(JSON.parse((await call(admin, {})).text).position).toBe(70);
  });

  test("a read-only token cannot set it", async () => {
    const r = await call(adminRo, { position: 10, dryRun: false });
    expect(r.error).toBe(true);
    expect(getEconomics(app.db).position).toBe(70);
  });

  test("a non-admin is told not found, to read or to set", async () => {
    expect((await call(bob, {})).error).toBe(true);
    const r = await call(bob, { position: 5, dryRun: false });
    expect(r.error).toBe(true);
    expect(getEconomics(app.db).position).toBe(70);
  });

  test("an admin agent token is told not found, to read or to set", async () => {
    const read = await call(agent, {});
    expect(read.error).toBe(true);
    expect(read.text).toContain("not_found");
    const set = await call(agent, { position: 5, dryRun: false });
    expect(set.error).toBe(true);
    expect(set.text).toContain("not_found");
    expect(getEconomics(app.db).position).toBe(70);
  });

  test("an rw token held by an admin is forbidden to set it", async () => {
    const r = await call(adminRw, { position: 5, dryRun: false });
    expect(r.error).toBe(true);
    expect(r.text).toContain("forbidden");
    expect(getEconomics(app.db).position).toBe(70);
  });
});
