/** The plan reads in milliseconds and is kept by what it reads, not by any write on the forge (#6122). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createApp, type App } from "../src/app.ts";
import { planStamp, readPlan } from "../src/core/milestones.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { clearMapCache, planBuildCount } from "../src/web/map_cache.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();

const PILLARS = 10;
const CLOSED = 2000;
const OPEN = 300;

let root = "";
let app: App;
let servers: Servers;
let cookie = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-milestones-speed-"));
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
  for (const name of ["forge", "other"]) {
    const made = await createRepo(app, { id: u.value.id, username: "alice" } as never, { name });
    if (!made.ok) throw new Error(made.error);
  }
  const repoId = getRepo(app.db, "alice", "forge")!.id;
  const issue = app.db.prepare(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at, closed_at)
     VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, ?6, ?7, ?7, ?8)`,
  );
  const edge = app.db.prepare(
    "INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)",
  );
  const at = new Date(Date.now() - 3_600_000).toISOString();
  app.db.transaction(() => {
    let n = 0;
    const total = CLOSED + OPEN;
    for (let p = 0; p < PILLARS; p++)
      issue.run(`u-${p}`, repoId, ++n, `P${p + 1} Pillar ${p + 1}: ask`, u.value.id, "open", at, null);
    for (let k = 0; k < total; k++) {
      const closed = k < CLOSED;
      issue.run(`c-${k}`, repoId, ++n, `Step ${k}`, u.value.id, closed ? "closed" : "open", at, closed ? at : null);
      edge.run(`u-${k % PILLARS}`, `c-${k}`);
    }
    app.db.run("UPDATE repo SET issue_seq = ?1 WHERE id = ?2", [n, repoId]);
  })();
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

const list = async () => {
  const res = await fetch(`${servers.url}/alice/forge/milestones`, { headers: { cookie } });
  await res.text();
  return res.status;
};

test("readPlan of 2,000 closed and 300 open issues under 10 pillars costs a bounded number of statements", async () => {
  const repo = getRepo(app.db, "alice", "forge")!;
  // Counted, not timed (#7824): the plan reads the repository's issues in a fixed number of
  // statements, never one per issue (2,300 issues here).
  let plan = readPlan(app.db, repo, { spend: true });
  expectWork(await statements(app.db, () => void (plan = readPlan(app.db, repo, { spend: true }))), { max: 22 });
  expect(plan.limbs).toHaveLength(PILLARS);
});

test("a write to another repository keeps the plan warm; a new issue here refreshes it", async () => {
  clearMapCache();
  const owner = getUserByName(app.db, "alice")!;
  await list();
  const warm = planBuildCount();
  await list();
  expect(planBuildCount()).toBe(warm);

  const other = getRepo(app.db, "alice", "other")!;
  expect(openIssue(app, owner, other, { title: "Elsewhere" }).ok).toBe(true);
  await list();
  expect(planBuildCount()).toBe(warm);

  const repo = getRepo(app.db, "alice", "forge")!;
  const before = planStamp(app.db, repo);
  expect(openIssue(app, owner, repo, { title: "Here" }).ok).toBe(true);
  expect(planStamp(app.db, repo)).not.toBe(before);
  await list();
  expect(planBuildCount()).toBe(warm + 1);
});

test("a milestone page names session, repo, plan and render", async () => {
  const res = await fetch(`${servers.url}/alice/forge/milestones/1`, { headers: { cookie } });
  expect(res.status).toBe(200);
  await res.text();
  const parts = (res.headers.get("server-timing") ?? "").split(", ");
  for (const name of ["session", "repo", "plan", "render"])
    expect(parts.find((p) => p.startsWith(`${name};`))).toMatch(/^[a-z]+;dur=\d+\.\d$/);
});

test("a cold plan names its stretches, costs a bounded number of statements, and keeps each limb's counts", async () => {
  const stretches: string[] = [];
  const repo = getRepo(app.db, "alice", "forge")!;
  let plan = readPlan(app.db, repo, { spend: true });
  expectWork(await statements(app.db, () => {
    stretches.length = 0;
    plan = readPlan(app.db, repo, { spend: true, stretch: (name) => stretches.push(name) });
  }), { max: 22 });
  expect(stretches).toEqual(["graph", "crew", "week", "spend", "limbs"]);
  expect(plan.limbs).toHaveLength(PILLARS);
  for (const limb of plan.limbs)
    expect(limb.weight).toMatchObject({ total: (CLOSED + OPEN) / PILLARS, done: CLOSED / PILLARS, open: OPEN / PILLARS });

  clearMapCache();
  const res = await fetch(`${servers.url}/alice/forge/milestones`, { headers: { cookie } });
  await res.text();
  const timing = res.headers.get("server-timing") ?? "";
  for (const name of ["plan-graph", "plan-limbs"]) expect(timing).toContain(`${name};dur=`);
});
