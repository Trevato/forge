/** An app's API reads name their Server-Timing phases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { tokenFor } from "./helpers/tokens.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

const call = (path: string, init: RequestInit = {}, token = bearer) =>
  fetch(`${servers.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  });

async function phases(path: string, token = bearer): Promise<{ status: number; names: string[] }> {
  const res = await call(path, {}, token);
  await res.arrayBuffer();
  const all = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  // The server's own leading `app` (and `db`) entries are not route phases.
  return { status: res.status, names: all.slice(all.indexOf("app") + 1) };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-apptime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
  });
  await runtime.start();
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  bearer = tokenFor(app, "alice", "admin");
  const made = await call("/api/v1/repos", { method: "POST", body: JSON.stringify({ name: "hello" }) });
  expect(made.status).toBe(201);
  const on = await call("/api/v1/repos/alice/hello/app", { method: "POST", body: "{}" });
  expect(on.status).toBe(201);
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const base = "/api/v1/repos/alice/hello/app";

for (const [route, read] of [
  [base, "app"],
  [`${base}/members`, "members"],
  [`${base}/domains`, "domains"],
  [`${base}/env`, "env"],
] as const) {
  test(`GET ${route} names session, ${read}, render in order`, async () => {
    const got = await phases(route);
    expect(got.status).toBe(200);
    expect(got.names).toEqual(["session", read, "render"]);
  });

  test(`a refused GET ${route} still names session`, async () => {
    const got = await phases(route.replace("/hello/", "/nothing/"));
    expect(got.status).toBe(404);
    expect(got.names).toEqual(["session"]);
  });
}
