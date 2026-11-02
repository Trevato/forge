/**
 * An app that sends `script-src 'self'` shows the pill (#8268): the tag points
 * at the app host's own copy, and `data-forge` keeps the forge's origin for its links.
 */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
import { TOOLBAR_ASSET_PATH } from "../src/apps/toolbar.ts";
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
      return new Response("<html><body><h1>hi</h1></body></html>", {
        headers: { "content-type": "text/html", "content-security-policy": "script-src 'self'" },
      });
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-same-origin-"));
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
  fetch(`${servers.url}${path}`, { headers: { host: `notes.${DOMAIN}`, accept: "text/html" }, redirect: "manual" });

test("under script-src 'self' the tag is same-origin and data-forge is the forge's origin", async () => {
  const res = await get("/");
  expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
  const html = await res.text();
  const tag = /<script src="([^"]+)"([^>]*)><\/script>/.exec(html);
  expect(tag).not.toBeNull();
  expect(tag![1]).toBe(TOOLBAR_ASSET_PATH);
  expect(new URL(tag![1]!, `http://notes.${DOMAIN}`).origin).toBe(`http://notes.${DOMAIN}`);
  expect(tag![2]).toContain(` data-forge="${servers.url}"`);
  // The same-origin copy answers, so the browser can run it.
  expect((await get(tag![1]!)).status).toBe(200);
});
