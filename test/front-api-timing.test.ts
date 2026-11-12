/** GET /api/v1/front names its phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ftime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the front read names session, front, render in order", async () => {
  const res = await fetch(`${servers.url}/api/v1/front`);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  const parts = requestTiming(res).split(", ");
  const names = parts.map((p) => p.split(";")[0]!).filter((n) => n !== "app");
  expect(names).toEqual(["session", "front", "render"]);
  for (const p of parts) expect(Number(/dur=([\d.]+)/.exec(p)?.[1])).not.toBeNaN();
});
