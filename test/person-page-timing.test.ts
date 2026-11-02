/** A person's page and an organization's page name their Server-Timing phases. */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-ptime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  const org = await fetch(`${servers.url}/api/v1/orgs`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "acme" }),
  });
  expect(org.status).toBe(201);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<string[]> {
  const res = await fetch(`${servers.url}${path}`);
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  return (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
}

for (const [what, path] of [["a person's page", "/alice"], ["an organization's page", "/acme"]] as const) {
  test(`${what} names session, owner, apps, repos, render`, async () => {
    const got = await phases(path);
    for (const name of ["session", "owner", "apps", "repos", "render"]) expect(got).toContain(name);
  });
}
