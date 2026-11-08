/** The forks API list names its phases in Server-Timing. */
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
  dataDir = await mkdtemp(join(tmpdir(), "forge-fkapi-"));
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

const names = (res: Response) =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!).filter((n) => n !== "app");

test("the forks list names session, forks, render in order", async () => {
  const made = await fetch(`${servers.url}/api/v1/repos`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ name: "yard" }),
  });
  expect(made.status).toBe(201);
  const res = await fetch(`${servers.url}/api/v1/repos/alice/yard/forks`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(200);
  expect(names(res)).toEqual(["session", "forks", "drift", "render"]);
});

test("a refused forks read still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/nope/forks`, { headers: { authorization: `Bearer ${bearer}` } });
  await res.arrayBuffer();
  expect(res.status).toBe(404);
  expect(names(res)).toContain("session");
});
