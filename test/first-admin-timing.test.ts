/** `/first-admin` names session and render in Server-Timing; it reads no data, so names no read (#3527). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-first-admin-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /first-admin names its phases", async () => {
  const res = await fetch(`${servers.url}/first-admin`);
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("Make this forge&#39;s first admin");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
