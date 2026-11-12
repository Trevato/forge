/**
 * An app whose CSP admits scripts by nonce (#8210): the pill's tag carries the
 * nonce from the response's own header, and none when it is malformed or absent.
 */

import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { newApp } from "../src/actions/apps.ts";
import { AppsRuntime, type EnvStatus } from "../src/apps/runtime.ts";
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
    fetch: (req) => {
      reached++;
      const path = new URL(req.url).pathname;
      const policy =
        path === "/bad"
          ? "script-src 'nonce-a\"><b'"
          : path === "/default"
            ? "default-src 'nonce-xyz'"
            : path === "/none"
              ? "script-src 'self'"
              : "script-src 'nonce-abc'";
      // The request's own words never reach the tag.
      return new Response(`<html><body><h1>hi</h1><i>nonce="evil"</i></body></html>`, {
        headers: { "content-type": "text/html", "content-security-policy": policy },
      });
    },
  });
  dataDir = await mkdtemp(join(tmpdir(), "forge-toolbar-nonce-"));
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

const tagOf = async (path: string) => {
  const html = await (await get(path)).text();
  const tag = /<script src="[^"]+"[^>]*><\/script>/.exec(html);
  expect(tag).not.toBeNull();
  return tag![0];
};

test("a script-src nonce is copied onto the pill's tag", async () => {
  expect(await tagOf("/")).toContain(' nonce="abc"');
});

test("default-src supplies the nonce when there is no script-src", async () => {
  expect(await tagOf("/default")).toContain(' nonce="xyz"');
});

test("a malformed nonce copies nothing", async () => {
  expect(await tagOf("/bad")).not.toContain("nonce=");
});

test("no nonce in the policy leaves the tag as before", async () => {
  expect(await tagOf("/none")).not.toContain("nonce=");
});
