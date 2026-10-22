/** GET /api/v1/contribute names its phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-cwt-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the contribute welcome names session, welcome, render in order", async () => {
  const res = await fetch(`${servers.url}/api/v1/contribute`);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]);
  expect(names.filter((n) => ["session", "welcome", "render"].includes(n!))).toEqual(["session", "welcome", "render"]);
});
