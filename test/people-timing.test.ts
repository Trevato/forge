/** `/settings/people` names session, people and render (and role on the POST) in Server-Timing (#3276). */
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

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-people-timing-"));
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
  servers = await serve(app);
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

async function signIn(username: string): Promise<string> {
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
    redirect: "manual",
  });
  return (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const phase = (res: Response, name: string) =>
  (res.headers.get("server-timing") ?? "").split(", ").find((p) => p.startsWith(`${name};`));

test("GET /settings/people names its phases", async () => {
  const cookie = await signIn("alice");
  const res = await fetch(`${servers.url}/settings/people`, { headers: { cookie } });
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("<h1>People</h1>");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["app", "session", "people", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("a non-admin gets the 403 without the admin phases", async () => {
  const b = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "bob",
    email: "bob@forge.local",
    password: "a-good-passphrase",
  });
  if (!b.ok) throw new Error(b.error);
  proveAll(app);
  const cookie = await signIn("bob");
  const get = await fetch(`${servers.url}/settings/people`, { headers: { cookie } });
  expect(get.status).toBe(403);
  for (const name of ["people", "render", "role"]) expect(phase(get, name)).toBeUndefined();
  const post = await fetch(`${servers.url}/settings/people/alice/role`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams({ role: "guest" }),
    redirect: "manual",
  });
  expect(post.status).toBe(403);
  for (const name of ["session", "role"]) expect(phase(post, name)).toBeUndefined();
});

test("POST /settings/people/:username/role names session and role", async () => {
  const cookie = await signIn("alice");
  const res = await fetch(`${servers.url}/settings/people/bob/role`, {
    method: "POST",
    headers: { cookie, origin: servers.url },
    body: new URLSearchParams({ role: "member" }),
    redirect: "manual",
  });
  expect(res.status).toBe(303);
  for (const name of ["session", "role"]) expect(phase(res, name)).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});
