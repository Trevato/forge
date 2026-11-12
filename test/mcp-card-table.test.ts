/**
 * docs/MCP.md has one table row per `ui://forge/<name>` the server lists, and
 * no row for a card the server no longer draws. The cards come from the live
 * `resources/list`, never from a grep of the source.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { CARD_OF_TOOL } from "../src/web/studio/cards.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-cardtable-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true,
    username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!a.ok) throw new Error("users");
  token = createToken(app.db, a.value.id, "admin", "admin").token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("docs/MCP.md has a table row for exactly the cards the server lists", async () => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }),
  });
  const body = (await res.json()) as any;
  const drawn = new Set<string>(
    body.result.resources.map((r: any) => String(r.uri)).filter((u: string) => /^ui:\/\/forge\/[a-z-]+$/.test(u)),
  );
  expect(drawn.size).toBeGreaterThan(0);
  const doc = await readFile(join(import.meta.dir, "..", "docs", "MCP.md"), "utf8");
  const described = new Set<string>();
  for (const m of doc.matchAll(/^\| `(ui:\/\/forge\/[a-z-]+)` \|/gm)) described.add(m[1]!);
  expect([...drawn].filter((u) => !described.has(u)).sort()).toEqual([]);
  expect([...described].filter((u) => !drawn.has(u)).sort()).toEqual([]);
});

test("each tool a card row names without a qualifier draws that card", async () => {
  const doc = await readFile(join(import.meta.dir, "..", "docs", "MCP.md"), "utf8");
  const wrong: string[] = [];
  for (const m of doc.matchAll(/^\| `ui:\/\/forge\/([a-z-]+)` \| ([^|]+) \|/gm)) {
    for (const item of m[2]!.split(",").map((x) => x.trim())) {
      const plain = /^`([a-z_]+)`$/.exec(item);
      if (plain && CARD_OF_TOOL[plain[1]!] !== undefined && CARD_OF_TOOL[plain[1]!] !== m[1]) wrong.push(`${plain[1]} → ${m[1]}`);
      if (/^`explore` with `kind: tree`/.test(item) && m[1] !== "explore") wrong.push(`explore tree → ${m[1]}`);
    }
  }
  expect(wrong).toEqual([]);
});
