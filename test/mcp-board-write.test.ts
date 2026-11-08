/** The `board_write` tool saves a board for a forge admin who is a person, and for no one else. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

const panel = (title: string, query: unknown = { source: "runs", aggregate: "count" }) =>
  ({ title, chart: "number", query, w: 1, h: 1 });
const board = (title: string, panels: unknown[] = [panel("Runs")]) =>
  ({ title, range: "24h", refresh: "off", panels });

describe("MCP board_write", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: string;
  let bob: string;
  let bot: string;
  let id = 1;

  const write = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "board_write", arguments: args } }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };
  const read = (slug: string) =>
    fetch(`${servers.url}/api/v1/boards/${slug}`, { headers: { authorization: `Bearer ${alice}` } });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-board-write-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst: first });
      if (!u.ok) throw new Error(u.error);
      return u.value;
    };
    const a = await mk("alice", true);
    const b = await mk("bob");
    alice = createToken(app.db, a.id, "rw", "rw").token;
    bob = createToken(app.db, b.id, "rw", "rw").token;
    const made = await createAgent(app, a, { username: "boardwriter", brief: "x" });
    if (!made.ok) throw new Error(String(made.error));
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(made.value.user.id);
    bot = createToken(app.db, made.value.user.id, "bot", "rw").token;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a person admin writes a board by slug and the API answers it", async () => {
    const wrote = await write(alice, { slug: "ops", board: board("Ops") });
    expect(wrote.value).toMatchObject({ slug: "ops", title: "Ops" });
    const got = await read("ops");
    expect(got.status).toBe(200);
    const body: any = await got.json();
    expect(body.title).toBe("Ops");
    expect(body.panels[0].title).toBe("Runs");

    // Writing again replaces.
    expect((await write(alice, { slug: "ops", board: board("Ops two") })).value).toMatchObject({ title: "Ops two" });
    expect(((await (await read("ops")).json()) as any).title).toBe("Ops two");
  });

  test("an agent admin and a non-admin are refused with the board words, and nothing is written", async () => {
    for (const who of [bot, bob]) {
      const got = await write(who, { slug: "sneaky", board: board("Sneaky") });
      expect(got.error).toContain("forbidden");
      expect(got.error).toContain("boards are for a forge admin who is a person");
    }
    expect((await read("sneaky")).status).toBe(404);
  });

  test("a board the store refuses answers refused with the reason, and the old board stays", async () => {
    await write(alice, { slug: "keep", board: board("Keep") });
    const unknownSource = board("Broken", [panel("Nothing", { source: "nothing" })]);
    const badQuery = board("Broken", [panel("Bad", { source: "runs", aggregate: "no-such-aggregate" })]);
    for (const broken of [unknownSource, badQuery]) {
      const got = await write(alice, { slug: "keep", board: broken });
      expect(got.error).toContain("refused");
      expect(got.error).toMatch(/query|aggregate/);
    }
    expect(((await (await read("keep")).json()) as any).title).toBe("Keep");

    // A new slug with a bad board is not created either.
    expect((await write(alice, { slug: "fresh", board: unknownSource })).error).toContain("refused");
    expect((await read("fresh")).status).toBe(404);
  });
});
