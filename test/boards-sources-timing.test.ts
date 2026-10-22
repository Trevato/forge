/** GET /api/v1/boards/sources names its phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-bsrc-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const phases = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!).filter(Boolean);

test("the sources list names session, sources, render in order", async () => {
  const res = await fetch(`${servers.url}/api/v1/boards/sources`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  expect(phases(res).filter((n) => ["session", "sources", "render"].includes(n))).toEqual(["session", "sources", "render"]);
});

test("a refused read still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/boards/sources`);
  await res.arrayBuffer();
  expect([401, 403, 404]).toContain(res.status);
  expect(phases(res)).toContain("session");
  expect(phases(res)).not.toContain("sources");
});
