/** GET /api/v1/migrate/:job and …/origins/:id/mirror/:job name their phases in Server-Timing (#5013). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createOrigin } from "../src/core/origins.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createJob } from "../src/origins/jobs.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";
let userId = "";
let originId = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-job-timing-"));
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
  userId = u.value.id;
  const made = createOrigin(app.db, root, {
    userId,
    kind: "forgejo",
    apiUrl: "https://git.example.test/api/v1",
    webUrl: "https://git.example.test",
    login: "alice",
    token: "t0ken",
  });
  if (!made.ok) throw new Error(made.error);
  originId = made.value.id;
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

function names(res: Response): string[] {
  return (res.headers.get("server-timing") ?? "")
    .split(", ")
    .map((p) => p.split(";")[0]!)
    .filter((n) => ["session", "job", "render"].includes(n));
}

test("GET /api/v1/migrate/:job names session, job, render in order", async () => {
  const job = createJob("", "octo/streamed", { kind: "migrate", actorId: userId });
  const res = await fetch(`${servers.url}/api/v1/migrate/${job.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  expect(names(res)).toEqual(["session", "job", "render"]);
});

test("a refused migrate read still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/migrate/nope`, { headers: { cookie } });
  expect(res.status).toBe(404);
  await res.text();
  expect(names(res)[0]).toBe("session");
  const anon = await fetch(`${servers.url}/api/v1/migrate/nope`);
  expect(anon.status).toBe(401);
  await anon.text();
  expect(names(anon)[0]).toBe("session");
});

test("GET …/origins/:id/mirror/:job names session, job, render in order", async () => {
  const job = createJob(originId, "octo/streamed", { actorId: userId });
  const res = await fetch(`${servers.url}/api/v1/user/origins/${originId}/mirror/${job.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  expect(names(res)).toEqual(["session", "job", "render"]);
});

test("a refused mirror read still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/user/origins/${originId}/mirror/nope`, { headers: { cookie } });
  expect(res.status).toBe(404);
  await res.text();
  expect(names(res)[0]).toBe("session");
  const anon = await fetch(`${servers.url}/api/v1/user/origins/${originId}/mirror/nope`);
  expect([401, 403]).toContain(anon.status);
  await anon.text();
  expect(names(anon)[0]).toBe("session");
});
