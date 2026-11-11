/** The organization reads name their Server-Timing phases. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

const auth = () => ({ authorization: `Bearer ${bearer}`, "content-type": "application/json" });
const post = (path: string, body: unknown) =>
  fetch(`${servers.url}${path}`, { method: "POST", headers: auth(), body: JSON.stringify(body) });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-otime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  expect((await post("/api/v1/orgs", { name: "acme" })).status).toBe(201);
  expect((await post("/api/v1/orgs/acme/teams", { name: "dev" })).status).toBe(201);
});

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string, status = 200): Promise<string[]> {
  const res = await fetch(`${servers.url}${path}`, { headers: auth() });
  await res.arrayBuffer();
  expect(res.status).toBe(status);
  return requestTiming(res).split(", ").map((p) => p.split(";")[0]!).filter((n) => n !== "app" && n !== "db");
}

test("an org names session, org, render", async () => {
  expect(await phases("/api/v1/orgs/acme")).toEqual(["session", "org", "render"]);
});

test("an org's teams name session, teams, render", async () => {
  expect(await phases("/api/v1/orgs/acme/teams")).toEqual(["session", "teams", "render"]);
});

test("a team's members name session, members, render", async () => {
  expect(await phases("/api/v1/orgs/acme/teams/dev/members")).toEqual(["session", "members", "render"]);
});

test("the caller's orgs name session, orgs, render", async () => {
  expect(await phases("/api/v1/user/orgs")).toEqual(["session", "orgs", "render"]);
});

test("a refused read still names session", async () => {
  expect((await phases("/api/v1/orgs/nope", 404))[0]).toBe("session");
  expect((await phases("/api/v1/orgs/nope/teams", 404))[0]).toBe("session");
  expect((await phases("/api/v1/orgs/acme/teams/nope/members", 404))[0]).toBe("session");
});
