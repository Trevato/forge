/** `/migrate` and `/migrate/jobs/:job` name their phases in Server-Timing (#3504). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-migrate-timing-"));
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

function phases(res: Response): string[] {
  return (res.headers.get("server-timing") ?? "").split(", ");
}

function expectPhases(res: Response, names: string[]): void {
  for (const name of names)
    expect(phases(res).find((p) => p.startsWith(`${name};`))).toMatch(
      /^[a-z]+;dur=\d+\.\d$/,
    );
}

test("GET /migrate names its phases", async () => {
  const res = await fetch(`${servers.url}/migrate`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  expectPhases(res, ["app", "session", "origins", "agents", "render"]);
});

test("GET /migrate with branches asked for names the branches read", async () => {
  const res = await fetch(`${servers.url}/migrate?branches=1`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  expectPhases(res, ["session", "origins", "agents", "branches", "render"]);
});

test("GET /migrate/jobs/:job names its phases", async () => {
  const job = createJob("", "octo/streamed", { kind: "migrate", actorId: userId });
  const res = await fetch(`${servers.url}/migrate/jobs/${job.id}`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  expectPhases(res, ["app", "session", "job", "render"]);
});
