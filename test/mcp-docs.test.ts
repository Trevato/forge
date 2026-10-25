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

quietLogs();

/**
 * Tools that answer in tools/list and have no row yet. This list only shrinks:
 * document a tool, then delete its line. One name per line, so two pulls never edit the same line.
 */
const undocumented = new Set<string>([
  "sizes",
  "here",
  "share",
  "variant",
  "asks",
  "asks_act",
  "asks_decide",
  "asks_proposal",
  "proposal_tokens",
  "asks_undecide",
  "issue_teams",
  "model_grant",
  "whoami_can",
  "mint_invite",
  "account_role",
  "model_ceiling",
  "forges",
  "sever",
  "follow_mode",
  "propose_to_parent_forge",
  "forge_proposals",
  "family",
  "next_steps",
  "thought",
  "feed_chips",
  "returns",
  "spend",
  "attach_look",
  "access",
  "capacity",
  "scorecard",
  "flow",
  "contribute",
  "limits",
  "teams",
  "quotas",
  "signup",
  "boards",
  "board_write",
  "board_pins",
  "board_delete",
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
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  served = JSON.parse(await res.text()).result.tools.map((t: { name: string }) => t.name);
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

test("the allowlist names only undocumented tools", async () => {
  const rows = new Set(await documented());
  expect([...undocumented].filter((n) => rows.has(n) || !served.includes(n))).toEqual([]);
});
