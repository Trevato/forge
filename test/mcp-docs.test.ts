/** docs/MCP.md never falls behind the server: every tool in tools/list has a row, every row names a tool. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { listAt } from "./mcp-list.ts";

quietLogs();

/**
 * Tools that answer in tools/list and have no row yet. This list only shrinks:
 * document a tool, then delete its line. One name per line, so two pulls never edit the same line.
 * The test fails until a documented tool's line is deleted here.
 */
const undocumented = new Set<string>([
  "asks",
  "asks_act",
  "spend",
  "report",
]);

let dataDir: string;
let servers: Servers;
let served: string[];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-docs-"));
  const app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "ada",
    email: "ada@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  const token = createToken(app.db, made.value.id, "admin", "admin").token;
  served = (await listAt(servers.url, token)).result.tools.map((t: { name: string }) => t.name);
});

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

async function documented(): Promise<string[]> {
  const md = await Bun.file(join(import.meta.dir, "..", "docs", "MCP.md")).text();
  const names: string[] = [];
  let inTable = false;
  for (const line of md.split("\n")) {
    if (/^\|\s*tool\s*\|/.test(line)) inTable = true;
    else if (inTable && !line.startsWith("|")) break;
    else if (inTable) {
      const m = /^\|\s*`([^`]+)`\s*\|/.exec(line);
      if (m) names.push(m[1]!);
    }
  }
  return names;
}

test("every tool in tools/list has a row in docs/MCP.md", async () => {
  const rows = new Set(await documented());
  expect(rows.size).toBeGreaterThan(0);
  expect(served.filter((n) => !rows.has(n) && !undocumented.has(n))).toEqual([]);
});

test("every row in docs/MCP.md names a tool that exists", async () => {
  const live = new Set(served);
  expect((await documented()).filter((n) => !live.has(n))).toEqual([]);
});

test("no undocumented name has a row in docs/MCP.md: delete each stale line", async () => {
  const rows = new Set(await documented());
  const stale = [...undocumented].filter((n) => rows.has(n));
  expect(stale.map((n) => `${n}: documented, delete it from the undocumented set`)).toEqual([]);
});

test("every undocumented name is a tool tools/list answers", () => {
  const unknown = [...undocumented].filter((n) => !served.includes(n));
  expect(unknown.map((n) => `${n}: not in tools/list, delete it from the undocumented set`)).toEqual([]);
});
