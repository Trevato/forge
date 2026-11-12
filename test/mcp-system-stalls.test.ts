/** MCP `system` names the last hour's stalls and the route or job behind each (#10907). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { during } from "../src/perf/jobs.ts";
import { loopWatch } from "../src/perf/live.ts";
import { LIMIT_MS } from "../src/perf/loop.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let servers: Servers;
let token = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-sysstall-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "correct horse battery 9", isAdmin: true });
  if (!u.ok) throw new Error("alice");
  token = createToken(app.db, u.value.id, "t", "admin").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a stall under a named job is read through system, at most 10, most ms first", async () => {
  // The watch is the process's one: stalls and requests an earlier file left
  // would crowd the top 10 or be blamed ahead of the job. Start from nothing.
  loopWatch.clear();
  during("test-job-10907", () => 1);
  loopWatch.stalled(LIMIT_MS + 10, performance.now());
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "system", arguments: {} } }),
  });
  const body = (await res.json()) as any;
  const out = JSON.parse(body.result.content[0].text);
  expect(out.stalls.length).toBeLessThanOrEqual(10);
  expect(out.stalls).toContainEqual({ cause: "job:test-job-10907", ms: LIMIT_MS + 10, count: 1 });
  const ms = out.stalls.map((s: any) => s.ms);
  expect(ms).toEqual([...ms].sort((a, b) => b - a));
});
