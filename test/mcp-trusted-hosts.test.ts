/**
 * The `origins` tool's `hosts` action is Settings → Origins' internal-host list over
 * MCP: the same rules, the same refusals, a forge admin only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("MCP trusted_hosts", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let admin: string;
  let other: string;
  let everyday: string;
  let agent: string;
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
        params: { name: "origins", arguments: { action: "hosts", ...(args as object) } },
      }),
    });
    const body: any = await res.json();
    return { text: body.result.content[0].text as string, isError: body.result.isError === true };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-trusted-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
    if (!b.ok) throw new Error(b.error);
    admin = createToken(app.db, a.value.id, "admin", "admin").token;
    other = createToken(app.db, b.value.id, "admin", "admin").token;
    everyday = createToken(app.db, a.value.id, "everyday", "rw").token;
    const c = await createUser(app.db, { origin: "seed", trusted: true, username: "robot", email: "robot@forge.local", password: "a-good-passphrase" });
    if (!c.ok) throw new Error(c.error);
    app.db.query("UPDATE user SET is_admin = 1, is_agent = 1 WHERE id = ?1").run(c.value.id);
    agent = createToken(app.db, c.value.id, "robot", "admin").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("two hosts are set and read back", async () => {
    const set = await tool(admin, { hosts: "git.example.test\nLab.Example.Test" });
    expect(set.isError).toBe(false);
    expect(JSON.parse(set.text).hosts).toEqual(["git.example.test", "lab.example.test"]);
    const read = await tool(admin, {});
    expect(JSON.parse(read.text).hosts).toEqual(["git.example.test", "lab.example.test"]);
  });

  test("a rejected line is named and nothing is saved", async () => {
    const res = await tool(admin, { hosts: "ok.example.test\n10.0.0.1\nhttps://x.test" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("Not host names, so not trusted: 10.0.0.1, https://x.test");
    expect(JSON.parse((await tool(admin, {})).text).hosts).toEqual(["git.example.test", "lab.example.test"]);
  });

  test("a caller who may not edit is refused, reading and writing", async () => {
    for (const args of [{}, { hosts: "evil.example.test" }]) {
      const res = await tool(other, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Only a forge admin sets this.");
    }
    expect(JSON.parse((await tool(admin, {})).text).hosts).not.toContain("evil.example.test");
  });

  test("a forge admin's rw token is refused, reading and writing, and nothing is saved", async () => {
    for (const args of [{}, { hosts: "evil.example.test" }]) {
      const res = await tool(everyday, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("admin-scope token");
    }
    expect(JSON.parse((await tool(admin, {})).text).hosts).not.toContain("evil.example.test");
  });

  test("an agent account that is an admin is refused", async () => {
    for (const args of [{}, { hosts: "evil.example.test" }]) {
      const res = await tool(agent, args);
      expect(res.isError).toBe(true);
      expect(res.text).toContain("Only a forge admin sets this.");
    }
    expect(JSON.parse((await tool(admin, {})).text).hosts).not.toContain("evil.example.test");
  });
});
