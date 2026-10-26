/** The secrets list and a person's sign-ins name their Server-Timing phases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-sstime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string, auth = true): Promise<{ status: number; names: string[] }> {
  const res = await fetch(`${servers.url}${path}`, auth ? { headers: { authorization: `Bearer ${bearer}` } } : {});
  await res.arrayBuffer();
  const names = (res.headers.get("server-timing") ?? "").split(", ").filter(Boolean).map((p) => p.split(";")[0]!);
  return { status: res.status, names };
}

test("the secrets list names session, secrets, render in order", async () => {
  const got = await phases("/api/v1/secrets/forge");
  expect(got.status).toBe(200);
  expect(got.names.filter((n) => ["session", "secrets", "render"].includes(n))).toEqual(["session", "secrets", "render"]);
});

test("a refused secrets list still names session", async () => {
  const got = await phases("/api/v1/secrets/forge", false);
  expect(got.status).toBeGreaterThanOrEqual(401);
  expect(got.names).toContain("session");
  expect(got.names).not.toContain("secrets");
});

test("a person's sign-ins name session, signins, render in order", async () => {
  const got = await phases("/api/v1/users/alice/signins");
  expect(got.status).toBe(200);
  expect(got.names.filter((n) => ["session", "signins", "render"].includes(n))).toEqual(["session", "signins", "render"]);
});

test("a refused or missing sign-ins read still names session", async () => {
  const anon = await phases("/api/v1/users/alice/signins", false);
  expect(anon.status).toBe(401);
  expect(anon.names).toContain("session");
  const none = await phases("/api/v1/users/nobody/signins");
  expect(none.status).toBe(404);
  expect(none.names).toContain("session");
});
