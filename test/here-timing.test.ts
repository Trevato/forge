/** /api/v1/here names its phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-ctime-"));
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

const phases = (res: Response) =>
  requestTiming(res).split(", ").map((p) => p.split(";")[0]!).filter((n) => n !== "app");

test("the here read names session, here, render in that order", async () => {
  const res = await fetch(`${servers.url}/api/v1/here?path=/`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  expect(phases(res)).toEqual(["session", "here", "render"]);
});

test("a refused here read still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/here?path=/nope/not-a-page/at/all`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(404);
  expect(phases(res)[0]).toBe("session");
});
