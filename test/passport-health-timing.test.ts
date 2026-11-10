/** GET /api/v1/passport/health names its phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { issue } from "../src/kernel/passport.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pttime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const phases = (res: Response) =>
  requestTiming(res).split(", ").map((p) => p.split(";")[0]!).filter((n) => n && n !== "app");

const ask = (token?: string) =>
  fetch(`${servers.url}/api/v1/passport/health`, {
    headers: token === undefined ? {} : { authorization: `Passport ${token}` },
  });

test("a good passport names session and read in order", async () => {
  const r = issue(dataDir, { iss: "runner", aud: "forge", scopes: ["health:read"], ttlMs: 60_000, now: Date.now() });
  if (!r.ok) throw new Error(r.error);
  const res = await ask(r.value);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  expect(phases(res)).toEqual(["session", "read"]);
});

test("a refused passport names session only", async () => {
  const res = await ask();
  await res.arrayBuffer();
  expect(res.status).toBe(401);
  expect(phases(res)).toEqual(["session"]);
});
