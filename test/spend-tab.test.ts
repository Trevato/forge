/** Usage › Spend (`/settings/spend`) is a forge admin's: a guest signs in, anyone else finds nothing. */
import { afterAll, beforeAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo as initRepo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { addSubscription } from "../src/core/subscriptions.ts";
import { recordUsage } from "../src/core/usage.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const NOW = "2026-10-20T12:00:00.000Z";
const PASS = "a-good-passphrase";
let root = "";
let app: App;
let servers: Servers;

async function cookieOf(username: string): Promise<string> {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: PASS }),
    redirect: "manual",
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

beforeAll(async () => {
  setSystemTime(new Date(NOW));
  root = mkdtempSync(join(tmpdir(), "forge-spend-tab-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const users = [];
  for (const [i, username] of ["alice", "bob"].entries()) {
    const u = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username,
      email: `${username}@forge.local`,
      password: PASS,
      adminIfFirst: i === 0,
    });
    if (!u.ok) throw new Error(u.error);
    users.push(u.value);
  }
  proveAll(app);
  const bobsApp = await initRepo(app.db, app.reposRoot, {
    ownerId: users[1]!.id,
    name: "ledger-app",
    visibility: "public",
    description: "",
  });
  if (!bobsApp.ok) throw new Error(`repo: ${JSON.stringify(bobsApp)}`);
  const sub = addSubscription(app.db, root, { name: "work-plan", token: "sk-ant-api-test-token" });
  if (!sub.ok) throw new Error("subscription");
  const run = createRun(app.db, { repoId: bobsApp.value.id, kind: "agent" }).id;
  recordUsage(app.db, {
    runId: run,
    repoId: bobsApp.value.id,
    issueId: null,
    agentId: null,
    subscriptionId: sub.value.id,
    tokensIn: 1000,
    tokensOut: 100,
    costUsd: 12.34,
    wallMs: 1000,
    outcome: "ok",
    at: "2026-10-20T10:00:00.000Z",
  });
  servers = await serve(app);
});
afterAll(() => {
  setSystemTime();
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("a guest is sent to sign in", async () => {
  const res = await fetch(`${servers.url}/settings/spend`, { redirect: "manual" });
  expect(res.status).toBeGreaterThanOrEqual(300);
  expect(res.status).toBeLessThan(400);
  expect(res.headers.get("location")).toBe("/signin?next=%2Fsettings%2Fspend");
  expect(await res.text()).not.toContain("12.34");
});

test("a signed-in non-admin, even an app's owner, is told not found and sees no figure", async () => {
  const res = await fetch(`${servers.url}/settings/spend`, {
    headers: { cookie: await cookieOf("bob") },
  });
  const body = await res.text();
  expect(res.status).toBe(404);
  expect(body).not.toContain("12.34");
  expect(body).not.toContain("work-plan");
  expect(body).not.toContain("<h2>Spend</h2>");
});

test("a forge admin sees the seeded run's dollars by credential and by app", async () => {
  const res = await fetch(`${servers.url}/settings/spend`, {
    headers: { cookie: await cookieOf("alice") },
  });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("<h2>Spend</h2>");
  expect(body).toMatch(/data-by="[^"]*"/);
  expect(body).toContain("work-plan");
  expect(body).toContain("bob/ledger-app");
  expect(body).toContain("$12.34");
  expect(res.headers.get("server-timing") ?? "").toMatch(/(^|, )spend;dur=\d+\.\d/);
});
