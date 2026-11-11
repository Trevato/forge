/** The API's origin repository list names its Server-Timing phases (#3923). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

const PASSWORD = "alice-login-secret";
const TOKEN = "octo-origin-secret-9f2a";
const auth = `Basic ${Buffer.from(`alice:${PASSWORD}`).toString("base64")}`;

let dataDir: string;
let app: App;
let servers: Servers;
let fake: FakeForge;
let originId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-origin-repos-timing-"));
  const state = newFakeState("forgejo", "octo", TOKEN);
  state.repos.push({
    id: 41,
    fullName: "octo/widgets",
    cloneUrl: "http://127.0.0.1:1/octo/widgets.git",
    defaultBranch: "main",
  });
  fake = serveFakeForge(state);
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  await seedAdmin(app, { username: "alice", email: "alice@forge.test", password: PASSWORD });
  proveAll(app);
  const connected = await fetch(`${servers.url}/api/v1/user/origins`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ host: fake.url, token: TOKEN }),
  });
  originId = String(((await connected.json()) as { id: string }).id);
});

afterAll(async () => {
  fake.stop();
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

async function get(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { authorization: auth } });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("listing an origin's repositories names session, origin and render", async () => {
  const got = await get(`/api/v1/user/origins/${originId}/repos?refresh=1`);
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "origin", "render"]);
  expect(JSON.parse(got.body).map((r: { fullName: string }) => r.fullName)).toEqual([
    "octo/widgets",
  ]);
});

test("an unknown origin still answers 404 and names session and origin", async () => {
  const got = await get("/api/v1/user/origins/nope/repos");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session", "origin"]);
});

test("an unreachable origin answers 502 naming session and origin", async () => {
  app.db.query("DELETE FROM origin_repo WHERE origin_id = ?1").run(originId);
  fake.stop();
  const got = await get(`/api/v1/user/origins/${originId}/repos?refresh=1`);
  expect(got.status).toBe(502);
  expect(JSON.parse(got.body).error).toBe("origin_unreachable");
  expect(got.names).toEqual(["session", "origin"]);
});
