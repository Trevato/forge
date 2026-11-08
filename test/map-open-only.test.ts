/** GET …/map and MCP `map` hold open issues by default; `done` brings the closed back (#6176). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue, setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { getIssue } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers, token = "";
const CLOSED = 2000;
const OPEN = 299; // plus "Open after": 300 open

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapopen-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const made = await createRepo(app, u.value, { name: "plan", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const repo = made.value;
  const open = (title: string) => {
    const o = openIssue(app, u.value, repo, { title });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const first = open("Closed blocker");
  for (let i = 1; i < CLOSED; i++) open(`Closed ${i}`);
  const waiter = open("Open waiter");
  for (let i = 1; i < OPEN; i++) open(`Open ${i}`);
  // The graph holds a closed issue only while an open one waited on it.
  for (let n = first.number; n < first.number + CLOSED; n++)
    addDependency(app.db, waiter, getIssue(app.db, repo.id, n)!, u.value.id);
  // One edge between two open issues: it must survive the filter.
  addDependency(app.db, open("Open after"), waiter, u.value.id);
  token = createToken(app.db, u.value.id, "t", "rw").token;
  for (let n = first.number; n < first.number + CLOSED; n++)
    setIssueState(app, u.value, repo, getIssue(app.db, repo.id, n)!, "closed", {});
}, 120_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

type Map = { issues: { state: string }[]; edges: unknown[]; counts: { done: number }; ready: unknown[] };
const read = async (q = ""): Promise<{ map: Map; bytes: number }> => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/plan/map${q}`);
  const text = await res.text();
  return { map: JSON.parse(text) as Map, bytes: text.length };
};

test("by default only open issues and the edges between them, under 150 KB", async () => {
  const { map, bytes } = await read();
  expect(map.issues.length).toBe(OPEN + 1);
  expect(map.issues.every((i) => i.state === "open")).toBe(true);
  expect(map.edges.length).toBe(1);
  expect(map.counts.done).toBe(CLOSED);
  expect(bytes).toBeLessThan(150_000);
});

test("?done=1 brings every issue and edge back; the computed lists are the same", async () => {
  const all = await read("?done=1");
  const open = await read();
  expect(all.map.issues.length).toBe(CLOSED + OPEN + 1);
  expect(all.map.edges.length).toBe(CLOSED + 1);
  expect(open.map.ready).toEqual(all.map.ready);
});

const mcpMap = async (args: Record<string, unknown>): Promise<Map> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "map", arguments: { app: "alice/plan", ...args } } }),
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]!.text) as Map;
};

test("MCP map is open-only by default and takes done: true", async () => {
  const open = await mcpMap({});
  expect(open.issues.length).toBe(OPEN + 1);
  expect(open.issues.every((i) => i.state === "open")).toBe(true);
  expect(open.edges.length).toBe(1);
  expect(open.counts.done).toBe(CLOSED);
  const all = await mcpMap({ done: true });
  expect(all.issues.length).toBe(CLOSED + OPEN + 1);
  expect(all.edges.length).toBe(CLOSED + 1);
});
