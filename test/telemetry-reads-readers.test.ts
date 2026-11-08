/** `readers` on the MCP system tool and GET /api/v1/telemetry/system (#9088): the rows /system draws, behind the telemetry gate. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgent } from "../src/actions/crew.ts";
import { setTelemetryGrant } from "../src/actions/telemetry.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { countRead, resetTelemetryReads } from "../src/system/telemetry_reads.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();
let dir = "", app: App, servers: Servers, owner = "", granted = "", plain = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-readers-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@x.test", password: "a-long-telemetry-passphrase", isAdmin: true });
  if (!a.ok) throw new Error("alice");
  owner = createToken(app.db, a.value.id, "t", "admin").token;
  const alice = getUserByName(app.db, "alice")!;
  for (const name of ["bot", "plain"]) {
    const b = await createAgent(app, alice, { username: name });
    if (!b.ok) throw new Error(name);
    const t = createToken(app.db, b.value.user.id, "t", "ro").token;
    if (name === "bot") granted = t; else plain = t;
  }
  setTelemetryGrant(app, alice, "bot", true);
}, 30_000);
afterAll(async () => { servers.stop(); app.close(); await rm(dir, { recursive: true, force: true }); });

const api = async (token: string) => {
  const r = await fetch(`${servers.url}/api/v1/telemetry/system`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, body: r.status === 200 ? ((await r.json()) as any) : await r.text() };
};
const mcp = async (token: string) => {
  const r = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: {} } }),
  });
  const b = (await r.json()) as any;
  return b.error || b.result.isError ? { error: true, text: JSON.stringify(b) } : { error: false, body: JSON.parse(b.result.content[0].text) };
};

test("API and MCP carry the same readers rows, flagging a fast flow reader, without the read itself", async () => {
  resetTelemetryReads();
  const now = Date.now();
  for (let i = 0; i < 6; i++) countRead("flow", "poller", now - 20_000 + i * 1000);
  const viaApi = await api(granted);
  expect(viaApi.status).toBe(200);
  expect(viaApi.body.readers).toEqual([{ route: "flow", reader: "poller", reads: 6, meanIntervalMs: 1000, tooFast: true }]);
  const viaMcp = await mcp(granted);
  expect(viaMcp.error).toBe(false);
  // The API read above is counted by now (route system, reader bot); the MCP answer lists it, not itself.
  const rows = viaMcp.body.readers;
  expect(rows[0]).toEqual(viaApi.body.readers[0]);
  expect(rows.find((r: any) => r.route === "system" && r.reader === "bot").reads).toBe(1);
  expect((await api(owner)).body.readers.find((r: any) => r.route === "system" && r.reader === "bot").reads).toBe(2);
});

test("an agent without the grant gets the refusal and no reader names", async () => {
  countRead("flow", "secret-reader-name");
  const r = await api(plain);
  expect(r.status).toBe(403);
  expect(r.body).not.toContain("secret-reader-name");
  const m = await mcp(plain);
  expect(m.error).toBe(true);
  expect(m.text).not.toContain("secret-reader-name");
});
