/** MCP `board_delete`: a person admin removes a board; agents and non-admins are refused. */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { makeBoard } from "../src/actions/boards.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASS = "a-long-board-delete-passphrase";

describe("MCP board_delete", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: string;
  let bot: string;
  let bob: string;

  const user = (name: string) => getUserByName(app.db, name)!;
  const call = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_delete", arguments: args } }),
    });
    const body = (await res.json()) as any;
    return { error: body.result.isError === true, text: body.result.content[0].text as string };
  };
  const board = (slug: string, token: string) =>
    fetch(`${servers.url}/api/v1/boards/${slug}`, { headers: { authorization: `Bearer ${token}` } });
  const fresh = async (title: string) => {
    const made = await makeBoard(app, user("alice"), title);
    if (!made.ok) throw new Error(`board ${title}`);
    return made.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-board-delete-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    for (const [username, isAdmin] of [["alice", true], ["robo", true], ["bob", false]] as const) {
      const made = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@x.test`, password: PASS, isAdmin });
      if (!made.ok) throw new Error(username);
    }
    app.db.query("UPDATE user SET is_agent = 1 WHERE username = 'robo'").run();
    alice = createToken(app.db, user("alice").id, "t", "admin").token;
    bot = createToken(app.db, user("robo").id, "t", "admin").token;
    bob = createToken(app.db, user("bob").id, "t", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person admin deletes a board, which then answers 404", async () => {
    const slug = await fresh("Doomed");
    expect((await board(slug, alice)).status).toBe(200);
    const done = await call(alice, { slug });
    expect(done.error).toBe(false);
    expect(JSON.parse(done.text)).toEqual({ deleted: slug });
    expect((await board(slug, alice)).status).toBe(404);
  });

  test("an unknown slug is not_found", async () => {
    const done = await call(alice, { slug: "no-such-board" });
    expect(done.error).toBe(true);
    expect(done.text).toContain("not_found");
    expect(done.text).toContain("no such board");
  });

  test("an agent admin and a non-admin are refused, and the board stays", async () => {
    const slug = await fresh("Kept");
    for (const token of [bot, bob]) {
      const done = await call(token, { slug });
      expect(done.error).toBe(true);
      expect(done.text).toContain("forbidden");
    }
    expect((await board(slug, alice)).status).toBe(200);
  });
});
