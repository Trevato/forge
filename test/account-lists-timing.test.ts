/** The caller's tokens, origins and origin apps lists name their phases in Server-Timing. */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-altime-"));
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

const basic = `Basic ${btoa("alice:correct-horse-battery")}`;
const phases = (res: Response) =>
  requestTiming(res).split(", ").map((p) => p.split(";")[0]!).filter((n) => n && n !== "app");

for (const [path, read] of [
  ["/api/v1/tokens", "tokens"],
  ["/api/v1/user/origins", "origins"],
  ["/api/v1/user/origin-apps", "apps"],
] as const) {
  test(`${path} names session, ${read}, render in order`, async () => {
    const res = await fetch(`${servers.url}${path}`, { headers: { authorization: path === "/api/v1/tokens" ? basic : `Bearer ${bearer}` } });
    await res.arrayBuffer();
    expect(res.status).toBe(200);
    expect(phases(res)).toEqual(["session", read, "render"]);
  });

  test(`${path} refused still names session`, async () => {
    const res = await fetch(`${servers.url}${path}`);
    await res.arrayBuffer();
    expect(res.status).toBeGreaterThanOrEqual(401);
    expect(phases(res)).toEqual(["session"]);
  });
}
