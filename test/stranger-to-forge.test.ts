/**
 * A stranger to a planned forge through the API alone (#3096, part of #2914):
 * sign up with a username and password, sign in, take a token, and plan a
 * forge. No socket, each request handed to forgeHttp(app).handle. Each step
 * is its own test, so a failure names the step that broke.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const ORIGIN = "http://forge.test";
const USERNAME = "stranger";
const PASSWORD = "a-long-passphrase";

let dir = "";
let app: App;
let http: ForgeHttp;
let cookie = "";
let token = "";

const call = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  http.handle(
    new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-stranger-"));
  delete process.env.FORGE_EDGE_TOKEN;
  app = createApp({ dataDir: dir, port: 0 });
  http = forgeHttp(app);
});

afterAll(async () => {
  http.close();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("step 1, sign-up: a username and a password, no email, makes an account", async () => {
  const res = await call("/api/v1/users", { username: USERNAME, password: PASSWORD });
  expect(res.status).toBe(201);
});

test("step 2, sign-in: the same credentials open a session", async () => {
  const res = await call("/api/v1/sessions", { username: USERNAME, password: PASSWORD });
  expect(res.status).toBe(201);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).not.toBe("");
});

test("step 3, token: the session mints an rw token", async () => {
  const res = await call("/api/v1/tokens", { scope: "rw", name: "stranger-to-forge" }, { cookie });
  expect(res.status).toBe(201);
  token = ((await res.json()) as { token?: string }).token ?? "";
  expect(token).not.toBe("");
});

test("step 4, plan: a dry-run POST /api/v1/forges names the owner as first admin", async () => {
  const res = await call(
    "/api/v1/forges",
    { name: "strangers-forge", dryRun: true },
    { authorization: `Bearer ${token}` },
  );
  expect(res.status).toBe(200);
  const plan = (await res.json()) as { dryRun?: boolean; firstAdmin?: string | null };
  expect(plan.dryRun).toBe(true);
  expect(plan.firstAdmin).toBe(USERNAME);
});

test("an anonymous plan names no first admin: whoever claims the child becomes it", async () => {
  const res = await call("/api/v1/forges", { name: "claimed-later", dryRun: true });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { firstAdmin?: string | null }).firstAdmin).toBeNull();
});
