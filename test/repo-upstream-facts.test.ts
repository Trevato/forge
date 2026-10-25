/** A repository read says how far behind its upstream it is, over the API and the MCP alike. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { noteCheck, putFollow } from "../src/core/upstream_follow.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let token = "";
let reader = "";
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-repo-upstream-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  token = createToken(app.db, made.value.id, "t", "ro").token;
  const bob = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!bob.ok) throw new Error(String(bob.error));
  reader = createToken(app.db, bob.value.id, "r", "ro").token;
  const fork = async (name: string, reading?: { behind: number; error: string }) => {
    const r = await createRepo(app, made.value, { name, visibility: "public" });
    if (!r.ok) throw new Error(String(r.error));
    if (reading === undefined) return;
    putFollow(app.db, { repoId: r.value.id, url: "https://example.com/up/lib.git", branch: "main", enabled: true, byId: made.value.id, originId: "" });
    noteCheck(app.db, r.value.id, { at: "2026-10-25T10:00:00.000Z", tip: "a".repeat(40), ...reading });
  };
  await fork("behind", { behind: 3, error: "" });
  await fork("level", { behind: 0, error: "" });
  await fork("clash", { behind: 2, error: "conflict" });
  await fork("plain");
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

const viaApi = async (name: string) =>
  ((await (await fetch(`${servers.url}/api/v1/repos/alice/${name}`, { headers: { authorization: `Bearer ${token}` } })).json()) as any).upstream;

const viaMcp = async (name: string) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo", arguments: { repo: `alice/${name}` } } }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text).upstream;
};

const want = (behind: number, conflict: boolean) => ({
  repo: "example.com/up/lib",
  behind,
  checkedAt: "2026-10-25T10:00:00.000Z",
  conflict,
});

test("a fork that is behind says how far", async () => {
  expect(await viaApi("behind")).toEqual(want(3, false));
  expect(await viaMcp("behind")).toEqual(want(3, false));
});

test("a fork that is level says zero", async () => {
  expect(await viaApi("level")).toEqual(want(0, false));
  expect(await viaMcp("level")).toEqual(want(0, false));
});

test("a fork whose last check conflicted says so", async () => {
  expect(await viaApi("clash")).toEqual(want(2, true));
  expect(await viaMcp("clash")).toEqual(want(2, true));
});

test("a repository that follows nothing answers null", async () => {
  expect(await viaApi("plain")).toBeNull();
  expect(await viaMcp("plain")).toBeNull();
});

test("only an admin sees it: an anonymous reader and a non-admin reader get null", async () => {
  const anon = ((await (await fetch(`${servers.url}/api/v1/repos/alice/behind`)).json()) as any).upstream;
  expect(anon).toBeNull();
  const other = ((await (await fetch(`${servers.url}/api/v1/repos/alice/behind`, { headers: { authorization: `Bearer ${reader}` } })).json()) as any).upstream;
  expect(other).toBeNull();
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${reader}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "repo", arguments: { repo: "alice/behind" } } }),
  });
  expect(JSON.parse(((await res.json()) as any).result.content[0].text).upstream).toBeNull();
});
