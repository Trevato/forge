/** The API's milestones and upstream proposals reads name their Server-Timing phases (#3939). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";
import { requestTiming } from "./helpers/request-timing.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let cookie = "";
let umbrella = 0;
const cells = process.env["FORGE_CELLS"];

beforeAll(async () => {
  process.env["FORGE_CELLS"] = "off";
  dataDir = await mkdtemp(join(tmpdir(), "forge-api-milestones-timing-"));
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
  // A milestone is an issue that waits for another issue.
  const open = (title: string) => {
    const made = createIssue(app.db, { repoId: repo.value.id, authorId: alice.id, title });
    if (!made.ok) throw new Error(String(made.error));
    return made.value;
  };
  const parent = open("umbrella");
  const child = open("step");
  const linked = addDependency(app.db, parent, child, alice.id);
  if (!linked.ok) throw new Error(String(linked.error));
  umbrella = parent.number;
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
  const names = requestTiming(res).split(", ").map((p) => p.split(";")[0]!);
  return { status: res.status, names: names.slice(names.indexOf("app") + 1), body };
}

test("the milestones list names session, read, render", async () => {
  const got = await phases("/api/v1/repos/alice/r/milestones");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "read", "render"]);
});

test("the proposals read names session, read, render", async () => {
  const got = await phases("/api/v1/repos/alice/r/following/proposals");
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "read", "render"]);
  expect(JSON.parse(got.body).items).toBeArray();
});

test("one milestone names session, read, render; a miss names session and read", async () => {
  const list = JSON.parse((await phases("/api/v1/repos/alice/r/milestones")).body);
  expect(list.items.length).toBeGreaterThan(0);
  const got = await phases(`/api/v1/repos/alice/r/milestones/${umbrella}`);
  expect(got.status).toBe(200);
  expect(got.names).toEqual(["session", "read", "render"]);
  const miss = await phases("/api/v1/repos/alice/r/milestones/9999");
  expect(miss.status).toBe(404);
  expect(miss.names).toEqual(["session", "read"]);
});

test("a missing repository still names session", async () => {
  for (const path of ["milestones", "milestones/1", "following/proposals"]) {
    const got = await phases(`/api/v1/repos/alice/nope/${path}`);
    expect(got.status).toBe(404);
    expect(got.names).toEqual(["session"]);
  }
});
