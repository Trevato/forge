/** `/home/archived/:op` names session, op and render in Server-Timing (#3528). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let repoId = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-home-archived-timing-"));
  app = createApp({ dataDir: root, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "keeper",
    email: "keeper@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  promote(app.db, u.value);
  cookie = `forge_session=${createSession(app.db, u.value.id).token}; forge_mode=studio`;
  const made = await createRepo(app, u.value, { name: "alpha", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  insertApp(app.db, { repoId: made.value.id, slug: "alpha", access: "public" });
  repoId = made.value.id;
}, 30_000);
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /home/archived/:op names its phases", async () => {
  const archived = await fetch(`${servers.url}/home/archive`, {
    method: "POST",
    headers: {
      cookie,
      origin: servers.url,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `repo=${repoId}`,
    redirect: "manual",
  });
  expect(archived.status).toBe(303);
  const receipt = archived.headers.get("location")!;
  expect(receipt).toStartWith("/home/archived/");
  const res = await fetch(`${servers.url}${receipt}`, { headers: { cookie }, redirect: "manual" });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("<h1>Archived</h1>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "op", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
