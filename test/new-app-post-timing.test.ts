/** POST /apps/new and POST /api/v1/apps name their phases and answer under 1 s (#3667). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-new-app-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const PHASES = ["session", "scaffold", "repo", "app", "issue"];

function expectPhases(res: Response): void {
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  // `app;` is also the total-handler entry every response carries, so it
  // appears twice; each other phase exactly once.
  for (const name of PHASES) {
    const found = parts.filter((p) => p.startsWith(`${name};`));
    expect(found).toHaveLength(name === "app" ? 2 : 1);
    for (const p of found) expect(p).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  }
}

test("POST /apps/new names its phases and answers under 1 s", async () => {
  const started = performance.now();
  const res = await fetch(`${servers.url}/apps/new`, {
    method: "POST",
    headers: { origin: servers.url, cookie },
    body: new URLSearchParams({ name: "timed", description: "A timed app" }),
    redirect: "manual",
  });
  const ms = performance.now() - started;
  expect(res.status).toBe(303);
  expectPhases(res);
  expect(ms).toBeLessThan(1000);
});

test("POST /api/v1/apps names its phases and answers under 1 s", async () => {
  const started = performance.now();
  const res = await fetch(`${servers.url}/api/v1/apps`, {
    method: "POST",
    headers: { origin: servers.url, cookie, "content-type": "application/json" },
    body: JSON.stringify({ name: "timed-api", description: "Another timed app" }),
  });
  const ms = performance.now() - started;
  expect(res.status).toBe(201);
  expectPhases(res);
  expect(ms).toBeLessThan(1000);
});
