/**
 * While the apps table is not loaded, an app's host is never the forge's
 * (#6726): it waits, then gets a 503 holding page with Retry-After; once
 * released, the host goes on to the app.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { createUser } from "../src/core/users.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { holdAppHost, holdAppHosts, releaseAppHosts } from "../src/apps/holding.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-holding-"));
  app = createApp({ dataDir, port: 0, host: "forge.test" });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = (host: string) => fetch(`${servers.url}/`, { headers: { host } });

test("with no runtime, an app host is the holding page — held or not, never the forge", async () => {
  holdAppHosts(app, "apps.test");
  const waiting = await holdAppHost(app, new Request("http://x/", { headers: { host: "notes.apps.test" } }), 20);
  expect(waiting?.status).toBe(503);
  expect(waiting?.headers.get("retry-after")).toBe("2");
  expect(await waiting?.text()).not.toContain("<title>forge</title>");

  // Released with no runtime (start threw, say): still the holding page.
  releaseAppHosts(app);
  const res = await get("notes.apps.test");
  expect(res.status).toBe(503);
  expect(res.headers.get("retry-after")).toBe("2");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(await res.text()).not.toContain("<title>forge</title>");
});

test("the forge's own host is the forge's", async () => {
  const own = await get("forge.test");
  expect(own.status).toBe(200);
  expect(await own.text()).toContain("<title>");
});

test("a request waiting for the runtime goes on once it is registered", async () => {
  const fresh = createApp({ dataDir: join(dataDir, "fresh"), port: 0, host: "forge.test" });
  holdAppHosts(fresh, "apps.test");
  const waiting = holdAppHost(fresh, new Request("http://x/", { headers: { host: "notes.apps.test" } }), 1500);
  new AppsRuntime(fresh, { domain: "apps.test", scheme: "http", publicPort: 80, forgeUrl: "http://forge.test", concurrency: 1 });
  releaseAppHosts(fresh);
  expect(await waiting).toBeUndefined();
  fresh.close();
});

test("the app's page once loaded: a request that waited is answered by the app side, not the forge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "forge-holding-app-"));
  const fresh = createApp({ dataDir: dir, port: 0, host: "forge.test" });
  holdAppHosts(fresh, "apps.test");
  const up = await serve(fresh);
  const u = await createUser(fresh.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const made = await newApp(fresh, u.value, { name: "notes", description: "x", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  try {
    const pending = fetch(`${up.url}/__forge/`, { headers: { host: "notes.apps.test" } });
    await Bun.sleep(30);
    new AppsRuntime(fresh, { domain: "apps.test", scheme: "http", publicPort: up.port, forgeUrl: up.url, concurrency: 1 });
    releaseAppHosts(fresh);
    const res = await pending;
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<h1>notes</h1>");
    expect(html).not.toContain("<title>forge</title>");
    // An unknown name is the app side's 404, never the forge's.
    const none = await fetch(`${up.url}/`, { headers: { host: "nothing.apps.test" } });
    expect(none.status).toBe(404);
    expect(await none.text()).not.toContain("<title>forge</title>");
  } finally {
    up.stop();
    fresh.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

test("only app hosts are held: forge-shaped and unrelated hosts are not, on an app with no runtime", async () => {
  const fresh = createApp({ dataDir: join(dataDir, "bare"), port: 0, host: "forge.test" });
  holdAppHosts(fresh, "apps.test");
  const ask = (host: string) => holdAppHost(fresh, new Request("http://x/", { headers: { host } }), 10);
  for (const host of ["forge.test", "a.b.apps.test", "elsewhere.example"])
    expect(await ask(host)).toBeUndefined();
  expect((await ask("notes.apps.test"))?.status).toBe(503);
  fresh.close();
});
