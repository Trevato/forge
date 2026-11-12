/** The served OpenAPI document describes the caller's password change and verification email. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminOpenapi } from "./helpers/openapi-doc.ts";

let dataDir: string;
let app: App;
let servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-openapi-account-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("the served document has the password and email verify routes", async () => {
  const res = await adminOpenapi(app, servers.url, "/contract/openapi.json");
  expect(res.status).toBe(200);
  const doc = (await res.json()) as any;
  const password = doc.paths["/api/v1/user/password"]?.post;
  const verify = doc.paths["/api/v1/user/email/verify"]?.post;
  expect(password).toBeDefined();
  expect(verify).toBeDefined();
  expect(JSON.stringify(password.requestBody)).toContain("current");
  expect(JSON.stringify(password)).toContain("bad_credentials");
  expect(JSON.stringify(verify)).toContain("too_soon");
});
