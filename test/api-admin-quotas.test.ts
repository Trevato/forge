/** `GET`/`PUT /api/v1/admin/quotas` read and set the per-account quotas, as MCP `quotas` does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { signUp } from "../src/actions/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { fixtureSlot } from "./helpers/slot.ts";

quietLogs();

const PASS = "a-long-member-passphrase";
let dataDir = "";
let app: App;
let servers: Servers;
let admin = "";
let ro = "";
let member = "";

async function mint(username: string, scope: string): Promise<string> {
  const res = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASS, name: scope, scope, adminConfirm: true }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { token: string }).token;
}
const get = (token: string) =>
  fetch(`${servers.url}/api/v1/admin/quotas`, { headers: { authorization: `Bearer ${token}` } });
const put = (token: string, key: string, value: unknown) =>
  fetch(`${servers.url}/api/v1/admin/quotas/${key}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ value }),
  });
const quotas = async (token: string) =>
  ((await (await get(token)).json()) as { quotas: Record<string, number | null> }).quotas;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-quotas-"));
  app = createApp({ dataDir, port: 0, url: "https://forge.example" });
  servers = await serve(app);
  await seedAdmin(app, { username: "olive", email: "olive@f.dev", password: PASS });
  const made = await signUp(app, { username: "bob", email: "bob@f.dev", password: PASS }, { slot: fixtureSlot(app) });
  if (!made.ok) throw new Error(made.error);
  admin = await mint("olive", "admin");
  ro = await mint("olive", "ro");
  member = await mint("bob", "rw");
});
afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("reads every quota, null when unset, with any scope", async () => {
  for (const token of [admin, ro]) {
    const res = await get(token);
    expect(res.status).toBe(200);
    const q = ((await res.json()) as { quotas: Record<string, number | null> }).quotas;
    expect(Object.keys(q).sort()).toEqual(["apps", "checks", "previews", "repositories", "runs", "storage"]);
    expect(q["apps"]).toBeNull();
  }
});

test("sets, then clears with null or an empty string", async () => {
  const set = await put(admin, "apps", 3);
  expect(set.status).toBe(200);
  expect(((await set.json()) as { value: number }).value).toBe(3);
  expect((await quotas(ro))["apps"]).toBe(3);
  expect((await put(admin, "apps", null)).status).toBe(200);
  expect((await quotas(ro))["apps"]).toBeNull();
  await put(admin, "runs", "7");
  expect((await quotas(ro))["runs"]).toBe(7);
  expect((await put(admin, "runs", "")).status).toBe(200);
  expect((await quotas(ro))["runs"]).toBeNull();
});

test("refuses an unknown key, a bad value, a ro token and a member", async () => {
  const unknown = await put(admin, "gold", 1);
  expect(unknown.status).toBe(422);
  expect(((await unknown.json()) as { error: string }).error).toBe("no_such_quota");
  for (const bad of [0, -1, 1.5, "abc", true]) {
    const res = await put(admin, "checks", bad);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_quota");
  }
  expect((await put(ro, "checks", 2)).status).toBe(403);
  expect((await quotas(admin))["checks"]).toBeNull();
  // A member without `administer` meets the shared admin gate (403) before the handler's 404.
  expect((await get(member)).status).toBe(403);
  expect((await put(member, "checks", 2)).status).toBe(403);
  expect((await quotas(admin))["checks"]).toBeNull();
});

test("a body without `value` is a 422 and leaves the quota as it was", async () => {
  expect((await put(admin, "previews", 4)).status).toBe(200);
  const raw = (body: string) =>
    fetch(`${servers.url}/api/v1/admin/quotas/previews`, {
      method: "PUT",
      headers: { authorization: `Bearer ${admin}`, "content-type": "application/json" },
      body,
    });
  for (const body of ["{}", '{"valeu":3}', ""]) {
    const res = await raw(body);
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe("invalid_quota");
  }
  expect((await quotas(ro))["previews"]).toBe(4);
  expect((await put(admin, "previews", null)).status).toBe(200);
});
