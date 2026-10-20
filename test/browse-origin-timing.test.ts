/** A connected origin's repository browse pages name their phases in Server-Timing. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { listOrigins } from "../src/core/origins.ts";
import { getUserByName } from "../src/core/users.ts";
import { forgetProviders } from "../src/origins/providers/index.ts";
import { clearViewCache } from "../src/view/cache.ts";
import { quietLogs } from "./helpers/globals.ts";
import { newFakeState, serveFakeForge, type FakeForge } from "./fake-origin.ts";
import { adminCookie } from "./helpers/admin.ts";

quietLogs();

const TOKEN = "octo-origin-secret-7c31";
const SHA = "a".repeat(40);

let dataDir = "";
let app: App, servers: Servers, fake: FakeForge;
let cookie = "", browse = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-borigtime-"));
  const state = newFakeState("forgejo", "octo", TOKEN);
  state.repos.push({
    id: 41,
    fullName: "octo/widgets",
    cloneUrl: "http://127.0.0.1:1/octo/widgets.git",
    htmlUrl: "http://127.0.0.1:1/octo/widgets",
    defaultBranch: "main",
  });
  state.files.set("octo/widgets", new Map([["README.md", "# widgets\n"]]));
  state.branches.set("octo/widgets", [{ name: "main", sha: SHA }]);
  fake = serveFakeForge(state);
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  delete process.env.FORGE_GITHUB_CLIENT_ID;
  cookie = await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-web-passphrase" });
  forgetProviders(dataDir);
  const connected = await fetch(`${servers.url}/settings/origins/token`, {
    method: "POST",
    headers: { cookie, origin: new URL(servers.url).origin },
    body: new URLSearchParams({ host: fake.url, token: TOKEN }),
    redirect: "manual",
  });
  expect(connected.status).toBe(303);
  const id = listOrigins(app.db, getUserByName(app.db, "alice")!.id)[0]!.id;
  browse = `/origins/${id}/r/octo/widgets`;
  clearViewCache();
});

afterAll(async () => {
  fake.stop();
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const names = (r: Response): string[] =>
  (r.headers.get("server-timing") ?? "").split(",").map((p) => p.trim().split(/[;=]/)[0]!);

test("the repository page names session, the origin reads, and render", async () => {
  const r = await fetch(`${servers.url}${browse}`, { headers: { cookie } });
  expect(r.status).toBe(200);
  expect(names(r)).toEqual(expect.arrayContaining(["session", "repo", "refs", "tree", "render"]));
});

test("the paths page names session, the origin reads, and render", async () => {
  clearViewCache();
  const r = await fetch(`${servers.url}${browse}/paths/main`, { headers: { cookie } });
  expect(r.status).toBe(200);
  expect(names(r)).toEqual(expect.arrayContaining(["session", "repo", "paths", "render"]));
});
