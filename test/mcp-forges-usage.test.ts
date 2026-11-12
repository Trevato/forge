/**
 * The MCP `forges` tool carries each child's size and use (#10903), from the
 * same `forgeUse` the machines page reads: a hosted child is "shared", a cell
 * child that is not running is "idle" with its limits; a plain admin is refused.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { SIZES } from "../src/spawn/sizes.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir: string;
let app: App;
let servers: Servers;
let token: string;
let rest: any;

const forges = async (tok: string) => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${tok}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "forges", arguments: {} } }),
  });
  const j = (await res.json()) as any;
  return { error: j.result.isError === true, body: JSON.parse(String(j.result.content[0].text)) };
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-mcp-forges-usage-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(JSON.stringify(made.error));
  token = createToken(app.db, made.value.id, "rw", "rw").token;
  await mkdir(join(dir, "spawn"), { recursive: true });
  const ledger = (name: string, extra: object) =>
    Bun.write(join(dir, "spawn", `${name}.json`), JSON.stringify({ name, bodyId: `b-${name}`, url: "", planHash: "x", done: true, forWhom: "Client", apps: [], createdAt: new Date().toISOString(), ...extra }));
  await ledger("hosted-kid", { size: "small", placement: "hosted" });
  await ledger("cell-kid", { size: "medium", placement: "cell" });
  const r = await fetch(`${servers.url}/api/v1/forges`, { headers: { authorization: `Bearer ${token}` } });
  rest = await r.json();
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("each forge item carries its size and use", async () => {
  const { error, body } = await forges(token);
  expect(error).toBe(false);
  const by = Object.fromEntries(body.forges.map((f: any) => [f.name, f]));
  expect(by["hosted-kid"].size).toBe("small");
  expect(by["hosted-kid"].use).toEqual({ kind: "shared" });
  expect(by["cell-kid"].size).toBe("medium");
  expect(by["cell-kid"].use).toEqual({ kind: "idle", limits: SIZES.medium });
});

test("the REST route the tool mirrors answers the same size and use", () => {
  const by = Object.fromEntries(rest.items.map((f: any) => [f.name, f]));
  expect(by["cell-kid"].size).toBe("medium");
  expect(by["cell-kid"].use).toEqual({ kind: "idle", limits: SIZES.medium });
});
