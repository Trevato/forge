/** `/board` names session, one phase per read and render in Server-Timing, and answers fast (#3388). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as makeAppRecord } from "../src/core/apps.ts";
import { createIssue } from "../src/core/issues.ts";
import { claimRun, createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { proveAll } from "./helpers/verified.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-board-page-timing-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  proveAll(app);
  const alice = { id: u.value.id, username: "alice" } as never;
  for (let r = 0; r < 10; r++) {
    const made = await createRepo(app, alice, { name: `app${r}` });
    if (!made.ok) throw new Error(String(made.error));
    const repoId = made.value.id;
    const rec = makeAppRecord(app.db, { repoId, slug: `app${r}`, access: "private" });
    if (!rec.ok) throw new Error(rec.error);
    for (let i = 0; i < 30; i++) {
      const issue = createIssue(app.db, { repoId, authorId: u.value.id, title: `Issue ${i} of app${r}` });
      if (!issue.ok) throw new Error(issue.error);
    }
    for (let i = 0; i < 5; i++) {
      const run = createRun(app.db, { repoId, kind: "agent", summary: `run ${i}` });
      claimRun(app.db, run.id);
    }
  }
  servers = await serve(app);
  const signin = await fetch(`${servers.url}/signin`, {
    method: "POST",
    headers: { origin: servers.url },
    body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
    redirect: "manual",
  });
  cookie = (signin.headers.get("set-cookie") ?? "").split(";")[0]!;
});
afterAll(() => {
  servers.stop();
  app.close();
  rmSync(root, { recursive: true, force: true });
});

test("GET /board names its phases and its own time is bounded", async () => {
  // The budget is 50 ms; the bound is 200 ms and the best of three warm reads, so a loaded runner cannot flake it.
  await fetch(`${servers.url}/board`, { headers: { cookie } });
  let res = await fetch(`${servers.url}/board`, { headers: { cookie } });
  const appOf = (r: Response) => Number(/app;dur=([\d.]+)/.exec(r.headers.get("server-timing") ?? "")?.[1]);
  let best = appOf(res);
  for (let i = 0; i < 2; i++) {
    const again = await fetch(`${servers.url}/board`, { headers: { cookie } });
    await again.arrayBuffer();
    best = Math.min(best, appOf(again));
  }
  const body = await res.text();
  expect(res.status).toBe(200);
  expect(body).toContain("board-grid");
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  const names = parts.map((p) => p.split(";")[0]!);
  for (const n of ["session", "repos", "apps", "scope", "forge", "declined", "review", "asks", "returns", "windows", "working", "landed", "decided", "today", "render"]) {
    expect(names.filter((x) => x === n).length).toBe(1);
    expect(parts.find((p) => p.startsWith(`${n};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
  }
  expect(best).toBeLessThan(200);
});
