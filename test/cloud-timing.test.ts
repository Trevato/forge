/** The cloud settings page names its phases in Server-Timing (#3444). */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-ctime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
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

test("the cloud settings page names session, each read and render once each", async () => {
  const res = await fetch(`${servers.url}/settings/cloud`, { headers: { authorization: `Bearer ${bearer}` } });
  const page = await res.text();
  expect(res.status).toBe(200);
  expect(page).toContain("Cloud accounts");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "reads", "uses", "accounts", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    const part = parts.find((p) => p.startsWith(`${n};`))!;
    expect(Number(/dur=([\d.]+)/.exec(part)?.[1])).not.toBeNaN();
  }
});
