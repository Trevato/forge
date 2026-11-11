/** /flow reads as plain sections under headings, no card boxes (#10011). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir = "";
let app: App;
let servers: Servers;
let repoId = "";

const login = async (username: string): Promise<string> => {
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
    body: new URLSearchParams({ username, password: "a-good-passphrase" }),
  });
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
};
const get = (cookie: string) => fetch(`${servers.url}/flow`, { headers: { cookie }, redirect: "manual" });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-flow-language-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const make = async (username: string, adminIfFirst: boolean) => {
    const u = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@forge.local`, password: "a-good-passphrase", adminIfFirst });
    if (!u.ok) throw new Error(u.error);
    return u.value;
  };
  const alice = await make("alice", true);
  await make("bob", false);
  const made = await createRepo(app, alice, { name: "shop" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
});
afterAll(async () => {
  servers.stop();
  await rm(dir, { recursive: true, force: true });
});

test("with no valves: pipes, then one muted line, no card", async () => {
  const text = await (await get(await login("alice"))).text();
  expect(text).not.toContain('class="card');
  expect(text).toContain('class="pipes');
  expect(text).toContain('<p class="muted">No repository has spent');
  expect(text).not.toContain("<h2>Valves</h2>");
});

test("with valves: an h2 over a plain list whose forms valveJs finds, no card", async () => {
  createRun(app.db, { repoId, kind: "agent", reason: "assigned" });
  const text = await (await get(await login("alice"))).text();
  expect(text).not.toContain('class="card');
  expect(text).toMatch(/<h2>Valves<\/h2>\s*<ul class="list">/);
  expect(text).toContain('class="valve-form"');
  expect(text).toContain('type="range"');
});

test("non-admins still get 404", async () => {
  expect((await get(await login("bob"))).status).toBe(404);
});
