/** Opening an app's environment through the API names its Server-Timing phases (#5361). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { AppsRuntime } from "../src/apps/runtime.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let runtime: AppsRuntime;
let cookie = "";

const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-app-open-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  runtime = new AppsRuntime(app, {
    domain: "apps.test",
    scheme: "http",
    publicPort: servers.port,
    forgeUrl: servers.url,
  });
  await runtime.start();
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!made.ok) throw new Error(String(made.error));
  const alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const repo = await createRepo(app, alice, { name: "r", visibility: "public" });
  if (!repo.ok) throw new Error(String(repo.error));
  insertApp(app.db, { repoId: repo.value.id, slug: "r", access: "public" });
});
afterAll(async () => {
  await runtime.stop();
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("opening production names session, repo, open in order, answer unchanged", async () => {
  const got = await phases("/api/v1/repos/alice/r/app/production/open");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "repo", "open"]);
  expect(typeof JSON.parse(got.body).url).toBe("string");
});

test("an unknown environment is still a 422 naming session, repo, open", async () => {
  const got = await phases("/api/v1/repos/alice/r/app/nope/open");
  expect(got.status).toBe(422);
  expect(got.names).toEqual(["session", "repo", "open"]);
});

test("a missing repository is a 404 naming session, repo", async () => {
  const got = await phases("/api/v1/repos/alice/nope/app/production/open");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session", "repo"]);
});
