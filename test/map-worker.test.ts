/**
 * The map answers from a worker with a read-only handle of its own (`map_worker.ts`) and says the
 * same thing the serving thread would: the same JSON, the same phases, and a write is seen by the
 * next read, never a snapshot of the one before.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { getRepoById, updateRepoSettings } from "../src/core/repos.ts";
import { sealedScope } from "../src/core/sealed.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { mapWorker, snapshotMap } from "../src/web/map_snapshot.ts";
import { readMap } from "../src/web/map_read.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir: string;
let app: App;
let servers: Servers;
let repoId: string;
let userId: string;
let bearer = "";
const MAP = "/api/v1/repos/alice/notes/map";
const mk = (title: string) => {
  const r = createIssue(app.db, { repoId, authorId: userId, title, body: "", kind: "issue", sealed: false });
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-mapworker-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  userId = admin.value.id;
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  repoId = made.value.id;
  updateRepoSettings(app.db, getRepoById(app.db, repoId)!, { plansNeedNod: false });
  const a = mk("First");
  const b = mk("Second");
  addDependency(app.db, b, a, userId);
  const minted = await fetch(`${servers.url}/api/v1/tokens`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adminConfirm: true, username: "alice", password: "correct-horse-battery", name: "cli", scope: "admin" }),
  });
  bearer = ((await minted.json()) as { token: string }).token;
  mapWorker.force = true;
});

afterAll(async () => {
  mapWorker.force = false;
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const get = async () => {
  const res = await fetch(`${servers.url}${MAP}`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  return { json: (await res.json()) as { issues: { number: number; title: string }[]; edges: unknown[] }, timing: res.headers.get("server-timing") ?? "" };
};

test("the worker's reading is the one the thread would make", async () => {
  const repo = getRepoById(app.db, repoId)!;
  const scope = sealedScope(app.db, repo, undefined);
  const viaWorker = await snapshotMap(app, { repoId, scope, now: new Date() });
  const inline = readMap(app, { repoId, scope });
  expect(viaWorker).toBeDefined();
  expect(mapWorker.answered).toBeGreaterThan(0);
  expect(JSON.parse(JSON.stringify(viaWorker!.value))).toEqual(JSON.parse(JSON.stringify(inline!.value)));
  expect(viaWorker!.phases.map(([name]) => name)).toEqual(["graph", "marks", "pillars", "asktolive", "held", "render"]);
});

test("a write is in the next answer, and a repeat with nothing written is a snapshot", async () => {
  const first = await get();
  expect(first.json.issues.map((i) => i.title)).toEqual(["First", "Second"]);
  expect(first.timing).toContain("graph");
  mk("Third");
  const second = await get();
  expect(second.json.issues.map((i) => i.title)).toEqual(["First", "Second", "Third"]);
  const asked = mapWorker.answered;
  const third = await get();
  expect(mapWorker.answered).toBe(asked);
  expect(third.json.issues.length).toBe(3);
  expect(third.timing).toContain("graph;dur=0.0");
});

test("a repository that is gone answers nothing", async () => {
  expect(await snapshotMap(app, { repoId: "no-such-repo", scope: {}, now: new Date() })).toBeUndefined();
});
