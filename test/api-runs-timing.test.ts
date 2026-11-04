/** The API runs list names its Server-Timing phases (#4893). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let runId = "";

const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-runs-timing-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
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
  runId = createRun(app.db, { repoId: repo.value.id, kind: "deploy", env: "production" }).id;
});
afterAll(async () => {
  await servers.stop();
  app.close();
  if (cells === undefined) delete process.env["FORGE_CELLS"];
  else process.env["FORGE_CELLS"] = cells;
  await rm(dataDir, { recursive: true, force: true });
});

async function phases(path: string): Promise<{ status: number; names: string[]; body: string }> {
  const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
  const body = await res.text();
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the runs list names session, tag, runs, render in order", async () => {
  const got = await phases("/api/v1/repos/alice/r/runs");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "tag", "runs", "render"]);
  expect(Array.isArray(JSON.parse(got.body).items)).toBe(true);
});

test("a missing repository is a 404 naming session", async () => {
  const got = await phases("/api/v1/repos/alice/nope/runs");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session"]);
});

test("one run's read names session, run, render in order, answer unchanged", async () => {
  const got = await phases(`/api/v1/repos/alice/r/runs/${runId}`);
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "run", "render"]);
  const body = JSON.parse(got.body);
  expect(body.id).toBe(runId);
  expect(body.carries).toEqual([]);
});

test("an unknown run is a 404 naming session, run", async () => {
  const got = await phases("/api/v1/repos/alice/r/runs/nope");
  expect(got.status).toBe(404);
  expect(got.names).toEqual(["session", "run"]);
});
