/** GET …/map names its Server-Timing phases: session, graph, marks, pillars, asktolive, render (#3320). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue } from "../src/core/issues.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { seedAdmin } from "./helpers/admin.ts";
import { requestTiming } from "./helpers/request-timing.ts";

let dataDir = "";
let app: App, servers: Servers, bearer = "";

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-maptime-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const made = await createRepo(app, admin.value, { name: "notes", visibility: "public", description: "" });
  if (!made.ok) throw new Error(String(made.error));
  const issues = [];
  for (let i = 0; i < 200; i++) {
    const r = createIssue(app.db, { repoId: made.value.id, authorId: admin.value.id, title: `Issue ${i}` });
    if (!r.ok) throw new Error(r.error);
    issues.push(r.value);
  }
  for (let i = 0; i < 50; i++) {
    const r = addDependency(app.db, issues[i + 1]!, issues[i]!, admin.value.id);
    if (!r.ok) throw new Error(r.error);
  }
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

test("the repository map names its phases in order, with durations", async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/notes/map`, { headers: { authorization: `Bearer ${bearer}` } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ready: unknown[] };
  expect(body.ready.length).toBeGreaterThan(0);
  const parts = requestTiming(res).split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  expect(names.filter((n) => n !== "app")).toEqual(["session", "graph", "marks", "pillars", "asktolive", "held", "render"]);
  for (const p of parts) expect(Number(/dur=([\d.]+)/.exec(p)?.[1])).not.toBeNaN();
});
