/** MCP explore says how many a filter leaves in the page's sentence, and the call that clears it. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { exploreCount, readExploreLine } from "../src/actions/explore.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
let dir: string;
let app: App;
let servers: Servers;
let token: string;

const explore = async (args: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "explore", arguments: args } }),
  });
  const r = (await res.json()) as any;
  return JSON.parse(r.result.content[0].text) as { total: number; line: string; clear?: unknown };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-explore-count-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const founder = await createUser(app.db, { origin: "seed", trusted: true, username: "founder", email: "f@x.test", password: "a-long-words-passphrase", adminIfFirst: true });
  if (!founder.ok) throw new Error("founder");
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-words-passphrase" });
  if (!made.ok) throw new Error("user");
  promote(app.db, made.value);
  const alice = getUserByName(app.db, "alice")!;
  const repo = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!repo.ok) throw new Error("repo");
  const rec = insertApp(app.db, { repoId: repo.value.id, slug: "alice-garden", access: "public" });
  if (!rec.ok) throw new Error("app");
  token = createToken(app.db, alice.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a filter with results: total, the page's sentence, and clear", async () => {
  const r = await explore({ q: "kind:app" });
  expect(r.total).toBe(1);
  expect(r.line).toBe(exploreCount(readExploreLine("kind:app").query, 1));
  expect(r.line).toBe("1 app");
  expect(r.clear).toEqual({ tool: "explore", arguments: {} });
});

test("a filter with none: the miss sentence and clear", async () => {
  const r = await explore({ q: "zzzznothing" });
  expect(r.total).toBe(0);
  expect(r.line).toBe(exploreCount(readExploreLine("zzzznothing").query, 0));
  expect(r.clear).toBeDefined();
});

test("no filter: a count and no clear", async () => {
  const r = await explore({});
  expect(r.total).toBeGreaterThan(1);
  expect(r.line).toBe(`${r.total} results`);
  expect(r.clear).toBeUndefined();
});
