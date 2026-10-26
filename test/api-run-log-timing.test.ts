/** The API's run log read names its phases in Server-Timing (#3782). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createRun, finishRun } from "../src/core/runs.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "", runId = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-apilogt-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const run = createRun(app.db, { repoId: made.value.id, kind: "check" });
  runId = run.id;
  finishRun(app.db, runId, { state: "ok", summary: "fine" });
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

const names = (res: Response): string[] =>
  (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!);

test("a finished run's plain log names session, log and render once each", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/runs/${runId}/log`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");
  await res.text();
  for (const n of ["session", "log", "render"]) expect(names(res).filter((x) => x === n).length).toBe(1);
});

test("a missing run answers 404 and still names session", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/runs/nope/log`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(404);
  expect(names(res)).toContain("session");
});
