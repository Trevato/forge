/** The MCP explore tool takes `q` as /llms.txt says (#9077); `query` stays an alias. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let token = "";

const rpc = async (method: string, params: unknown) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return ((await res.json()) as any).result;
};
const explore = async (args: unknown) => {
  const r = await rpc("tools/call", { name: "explore", arguments: args });
  return JSON.parse(r.content[0].text) as { items: { kind: string }[] };
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-explore-mcp-q-"));
  app = createApp({ dataDir, port: 0 });
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
  token = createToken(app.db, getUserByName(app.db, "alice")!.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("explore with q filters; query is an alias; q wins", async () => {
  const all = await explore({});
  expect(all.items.some((i) => i.kind === "app")).toBe(true);
  const people = await explore({ q: "kind:person" });
  expect(people.items.length).toBeGreaterThan(0);
  expect(people.items.every((i) => i.kind === "person")).toBe(true);
  const alias = await explore({ query: "kind:person" });
  expect(alias.items.every((i) => i.kind === "person")).toBe(true);
  const both = await explore({ q: "kind:person", query: "kind:app" });
  expect(both.items.length).toBe(people.items.length);
});

test("tools/list shows q first", async () => {
  const r = await rpc("tools/list", { all: true });
  const t = r.tools.find((x: any) => x.name === "explore");
  expect(Object.keys(t.inputSchema.properties)[0]).toBe("q");
});

test("llms.txt names every filter explore reads", async () => {
  const txt = await (await fetch(`${servers.url}/llms.txt`)).text();
  const line = txt.split("\n").find((l) => l.includes('MCP "explore"')) ?? "";
  for (const k of ["kind:", "sort:", "updated:", "owner:", "archived:", "1d, 7d or 30d", "yes or no"]) expect(line).toContain(k);
});

test("explore takes since like the page: the window narrows, a bad one is an error naming the valid ones (#11232)", async () => {
  const all = await explore({});
  const week = await explore({ since: "7d" });
  expect(week.items.length).toBeLessThan(all.items.length);
  const r = await rpc("tools/call", { name: "explore", arguments: { since: "9y" } });
  expect(r.isError).toBe(true);
  expect(r.content[0].text).toContain("1d, 7d, 30d");
});
