/** `/:owner/:name/app` names session, each read and render in Server-Timing (#3631). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { enableApp } from "../src/actions/apps.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";
import { ageApp, giveHistory } from "./helpers/history.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-studio-app-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
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
  const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name: "vault" });
  if (!made.ok) throw new Error(String(made.error));
  const seeded = await commitToBranch(app, u.value, made.value, {
    message: "Start",
    files: [{ path: "README.md", content: "v\n" }],
  });
  if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
  const enabled = await enableApp(app, u.value, made.value, { slug: "vault" });
  if (!enabled.ok) throw new Error(String(enabled.error));
  // A new app shows only its progress (#10299); this budget is the full page.
  ageApp(app.db, made.value.id);
  giveHistory(app.db, made.value.id);
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /:owner/:name/app names its phases", async () => {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  const cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
  const res = await fetch(`${servers.url}/alice/vault/app`, { headers: { cookie } });
  await res.text();
  expect(res.status).toBe(200);
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of [
    "app",
    "session",
    "opened",
    "crew",
    "pulls",
    "shipped",
    "spend",
    "decisions",
    "latency",
    "panels",
    "now",
    "following",
    "policy",
    "render",
  ])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
