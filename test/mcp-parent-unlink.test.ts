/** MCP `parent_unlink`: Settings' unlink of the parent forge's sign-in, from a harness. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ISSUER = "https://parent.test";

describe("MCP parent_unlink", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;

  const id = (name: string) => getUserByName(app.db, name)!.id;
  const links = (name: string) =>
    (app.db.query("SELECT COUNT(*) AS n FROM federated_identity WHERE user_id = ?1").get(id(name)) as { n: number }).n;
  const mcp = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "parent_unlink", arguments: {} } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-unlink-"));
    app = createApp({ dataDir, port: 0, parentUrl: ISSUER });
    servers = await serve(app);
    for (const [username, password] of [["alice", "a-long-unlink-passphrase"], ["bob", undefined], ["carol", "a-long-unlink-passphrase"], ["dave", "a-long-unlink-passphrase"]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, ...(password ? { password } : {}) });
      if (!made.ok) throw new Error(username);
    }
    for (const name of ["alice", "bob", "dave"])
      app.db.query("INSERT INTO federated_identity (issuer, sub, user_id) VALUES (?1, ?2, ?3)").run(ISSUER, `sub-${name}`, id(name));
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an account with a password and a parent link is unlinked", async () => {
    const out = await mcp(createToken(app.db, id("alice"), "t", "admin").token);
    expect(out.error).toBe(false);
    expect(out.text).toContain("Unlinked.");
    expect(links("alice")).toBe(0);
  });

  test("an account whose parent link is its only way in is refused and stays linked", async () => {
    const out = await mcp(createToken(app.db, id("bob"), "t", "admin").token);
    expect(out.error).toBe(true);
    expect(out.text).toContain("Add a passkey or a password first");
    expect(links("bob")).toBe(1);
  });

  test("nothing linked says so", async () => {
    const out = await mcp(createToken(app.db, id("carol"), "t", "admin").token);
    expect(out.error).toBe(false);
    expect(out.text).toContain("Nothing to unlink.");
  });

  test("a read-write token is refused", async () => {
    const out = await mcp(createToken(app.db, id("dave"), "t", "rw").token);
    expect(out.error).toBe(true);
    expect(links("dave")).toBe(1);
  });
});
