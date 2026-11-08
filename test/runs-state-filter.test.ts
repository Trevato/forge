/** `?state=` narrows a repository's runs page to one state (#6490). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { forgeHttp, type ForgeHttp } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir = "";
let app: App;
let http: ForgeHttp;
let failedId = "";
let okId = "";
let agentId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-rstate-"));
  app = createApp({ dataDir, port: 0 });
  http = forgeHttp(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const pub = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  const priv = await createRepo(app, admin.value, { name: "secret", visibility: "private", description: "" });
  if (!pub.ok || !priv.ok) throw new Error("repo");
  okId = createRun(app.db, { repoId: pub.value.id, kind: "check" }).id;
  claimRun(app.db, okId);
  finishRun(app.db, okId, { state: "ok", summary: "fine" });
  failedId = createRun(app.db, { repoId: pub.value.id, kind: "check" }).id;
  claimRun(app.db, failedId);
  finishRun(app.db, failedId, { state: "failed", summary: "broke" });
  agentId = createRun(app.db, { repoId: pub.value.id, kind: "agent" }).id;
  claimRun(app.db, agentId);
  finishRun(app.db, agentId, { state: "failed", summary: "agent broke" });
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await http.handle(new Request(`http://forge.test${path}`));
  return { status: res.status, body: await res.text() };
};

test("?state=failed lists only the failed run and marks its link", async () => {
  const { status, body } = await get("/alice/notes/runs?state=failed");
  expect(status).toBe(200);
  expect(body).toContain(`/alice/notes/runs/${failedId}`);
  expect(body).not.toContain(`/alice/notes/runs/${okId}`);
  // An agent run is kept under a state, though the default list leaves it out.
  expect(body).toContain(`/alice/notes/runs/${agentId}`);
  expect(body).toMatch(/<a\s+href="[^"]*state=failed"\s+aria-current="page"\s*>Failed/);
  const nav = body.match(/aria-label="Run state">[\s\S]*?<\/nav>/)?.[0] ?? "";
  expect(nav).toContain(`class="seg"`);
  expect(nav.match(/aria-current="page"/g)?.length).toBe(1);
});

test("an unknown state is ignored: every run, All is current", async () => {
  const { status, body } = await get("/alice/notes/runs?state=bogus");
  expect(status).toBe(200);
  expect(body).toContain(`/alice/notes/runs/${failedId}`);
  expect(body).toContain(`/alice/notes/runs/${okId}`);
  expect(body).toMatch(/<a\s+href="[^"]*\/runs"\s+aria-current="page"\s*>All/);
});

test("a private repository is still the one 404 to an outsider", async () => {
  const a = await get("/alice/secret/runs?state=failed");
  const b = await get("/alice/nothing/runs?state=failed");
  expect(a.status).toBe(404);
  expect(b.status).toBe(404);
});

test("the runs list is bare rows, not a boxed card (#9727)", async () => {
  const { body } = await get("/alice/notes/runs?state=failed");
  expect(body).toMatch(/<div\s+class="card bare"[^>]*>\s*<ul class="list">/);
  expect(body).toContain(`/alice/notes/runs/${failedId}`);
});
