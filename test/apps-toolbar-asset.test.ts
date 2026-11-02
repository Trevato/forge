/**
 * Every app host answers the forge pill's script from its own origin (#8267):
 * the exact hashed path gets the bytes the forge serves, immutable, with the
 * security headers; any other /__forge/toolbar… path is a 404 the app never sees.
 */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { TOOLBAR_ASSET_PATH, toolbarJs } from "../src/apps/toolbar.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const DOMAIN = "apps.test";
let reached = 0;

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let backend: ReturnType<typeof Bun.serve>;
let status: ReturnType<typeof spyOn>;

beforeAll(async () => {
  backend = Bun.serve({
    port: 0,
    fetch: () => {
      reached++;
      return new Response("the app");
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-asset-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: DOMAIN,
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
    concurrency: 1,
  });
  await runtime.start();
  status = spyOn(AppsRuntime.prototype, "envStatus").mockImplementation(
    () =>
      ({
        env: "production",
        state: "running",
        port: backend.port,
        commitOid: "a".repeat(40),
      }) as EnvStatus,
  );
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  const made = await newApp(app, a.value, {
    name: "notes",
    description: "A place for words",
    visibility: "public",
  });
  if (!made.ok) throw new Error(String(made.error));
}, 120_000);

afterAll(async () => {
  status.mockRestore();
  await runtime.stop();
  servers.stop();
  backend.stop(true);
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (path: string) =>
  fetch(`${servers.url}${path}`, { headers: { host: `notes.${DOMAIN}` }, redirect: "manual" });

test("the app's own host serves the pill's script, immutable, with the security headers", async () => {
  const res = await get(TOOLBAR_ASSET_PATH);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe(toolbarJs);
  expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("referrer-policy")).toBeTruthy();
  expect(reached).toBe(0);
});

test("a wrong hash, or any other /__forge/toolbar path, is a 404 the app never sees", async () => {
  for (const path of [
    "/__forge/toolbar-0000000000000000.js",
    "/__forge/toolbar.js",
    "/__forge/toolbar",
    `${TOOLBAR_ASSET_PATH}x`,
    "/__forge/toolbar/x",
  ])
    expect((await get(path)).status).toBe(404);
  expect(reached).toBe(0);
});
