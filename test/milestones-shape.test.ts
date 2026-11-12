/** A forge-shaped repository: pulls, runs, sealed issues and nested limbs, not only a flat fan of leaves. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { planStamp, readPlan } from "../src/core/milestones.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { expectWork } from "./helpers/work.ts";
import { statements } from "./helpers/statements.ts";
import { quietLogs } from "./helpers/globals.ts";
import { proveAll } from "./helpers/verified.ts";

quietLogs();
const PILLARS = 10;
let root = "";
let app: App;
let uid = "";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "forge-milestones-shape-"));
  app = createApp({ dataDir: root, port: 0, forgeRepo: "alice/forge" });
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  uid = u.value.id;
  proveAll(app);
  const made = await createRepo(app, { id: uid, username: "alice" } as never, { name: "forge" });
  if (!made.ok) throw new Error(made.error);
  const repoId = getRepo(app.db, "alice", "forge")!.id;
  const issue = app.db.prepare(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at, updated_at, closed_at, sealed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11)`,
  );
  const edge = app.db.prepare("INSERT INTO issue_dependency (issue_id, blocked_by_id) VALUES (?1, ?2)");
  const pull = app.db.prepare(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at) VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
  );
  const run = app.db.prepare(
    `INSERT INTO run (id, repo_id, kind, issue_id, state, cost_usd, actor_id, created_at, started_at) VALUES (?1, ?2, 'agent', ?3, ?4, 0.5, ?5, ?6, ?6)`,
  );
  const body = "Why this matters. ".repeat(70);
  const at = new Date(Date.now() - 3_600_000).toISOString();
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
  app.db.transaction(() => {
    let n = 0;
    for (let p = 0; p < PILLARS; p++)
      issue.run(`u-${p}`, repoId, ++n, "issue", `P${p + 1} Pillar ${p + 1}: ask`, "", uid, "open", at, null, 0);
    const leaves = 2300;
    for (let k = 0; k < leaves; k++) {
      const closed = k < 2000;
      issue.run(`c-${k}`, repoId, ++n, "issue", `Step ${k}`, body, uid, closed ? "closed" : "open", at, closed ? at : null, k % 8 === 3 ? 1 : 0);
      // a mid-level limb every 20 leaves, nested under its pillar; leaves chain behind each other
      if (k % 20 === 0) edge.run(`u-${Math.floor(k / 20) % PILLARS}`, `c-${k}`);
      else edge.run(`c-${k - (k % 20)}`, `c-${k}`);
      if (k % 20 > 1) edge.run(`c-${k - 1}`, `c-${k}`);
    }
    for (let k = 0; k < 3000; k++) {
      const merged = k < 2800;
      // 400 landed this week, the rest long ago
      const when = k < 400 ? at : old;
      issue.run(`p-${k}`, repoId, ++n, "pull", `Pull ${k}`, `${body}\nCloses #${PILLARS + 1 + (k % leaves)}`, uid, merged ? "closed" : "open", when, merged ? when : null, 0);
      pull.run(`p-${k}`, `b-${k}`, merged ? when : null);
    }
    for (let k = 0; k < 1500; k++) run.run(`r-${k}`, repoId, `c-${k % leaves}`, k < 30 ? "running" : "ok", uid, at);
    app.db.run("UPDATE repo SET issue_seq = ?1 WHERE id = ?2", [n, repoId]);
  })();
});
afterAll(() => {
  app.close();
  rmSync(root, { recursive: true, force: true });
});

const weights = (spend: boolean) =>
  readPlan(app.db, getRepo(app.db, "alice", "forge")!, { spend }).limbs.map((l) => [
    l.name, l.weight.total, l.weight.done, l.weight.open, l.weight.merged, l.weight.building, l.weight.spentUsd,
  ]);

/** What each limb weighs on the code before the stamp and the lean read: the counts must not move. */
const BEFORE = [
  ["P1 Pillar 1", 204, 170, 34, 34, 0, 68],
  ["P2 Pillar 2", 216, 180, 36, 36, 0, 72],
  ["P3 Pillar 3", 204, 170, 34, 34, 0, 68],
  ["P4 Pillar 4", 216, 180, 36, 36, 0, 72],
  ["P5 Pillar 5", 204, 170, 34, 34, 0, 68],
  ["P6 Pillar 6", 198, 180, 18, 36, 0, 63],
  ["P7 Pillar 7", 187, 170, 17, 34, 0, 59.5],
  ["P8 Pillar 8", 198, 180, 18, 36, 0, 63],
  ["P9 Pillar 9", 187, 170, 17, 34, 0, 59.5],
  ["P10 Pillar 10", 198, 180, 18, 36, 0, 63],
];

test("a plan of 2,000 closed and 300 open issues, 3,000 pulls and 1,500 runs reads in a bounded number of statements with the same limbs", async () => {
  const repo = getRepo(app.db, "alice", "forge")!;
  readPlan(app.db, repo, { spend: true });
  // Counted, not timed: the plan is a fixed number of reads however many issues, pulls and runs there are.
  expectWork(await statements(app.db, () => void readPlan(app.db, repo, { spend: true })), { max: 24 });
  expect(weights(true)).toEqual(BEFORE);
  expect(weights(false).map((w) => w.slice(0, 6))).toEqual(BEFORE.map((w) => w.slice(0, 6)));
});

test("a sealed issue is in no limb a viewer cannot see", () => {
  const repo = getRepo(app.db, "alice", "forge")!;
  const sealed = app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND sealed = 1").get(repo.id)!.n;
  expect(sealed).toBeGreaterThan(0);
  const plan = readPlan(app.db, repo, { spend: false });
  const seen = new Set(plan.read.graph.issues.map((i) => i.id));
  for (const row of app.db.query<{ id: string }, [string]>("SELECT id FROM issue WHERE repo_id = ?1 AND sealed = 1").all(repo.id))
    expect(seen.has(row.id)).toBe(false);
});

test("the stamp is kept while nothing is written, and moves when an issue is", async () => {
  const repo = getRepo(app.db, "alice", "forge")!;
  const first = planStamp(app.db, repo);
  for (let n = 0; n < 20; n++) expect(planStamp(app.db, repo)).toBe(first);
  expectWork((await statements(app.db, () => { for (let n = 0; n < 20; n++) planStamp(app.db, repo); })) / 20, { max: 1 });
  expect(openIssue(app, getUserByName(app.db, "alice")!, repo, { title: "Fresh" }).ok).toBe(true);
  expect(planStamp(app.db, repo)).not.toBe(first);
});
