/**
 * readBuildYield and sweepAssigned never scan `event` or `run` on a big forge (#7874):
 * the plan names the indexes, the answer equals the old query's, and the time stays small.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { BUILD_YIELD_SQL, readBuildYield } from "../src/flow/build_yield.ts";
import { SWEEP_ASSIGNED_SQL } from "../src/crew/dispatch.ts";

const NOW = new Date("2026-11-02T00:00:00.000Z");
const ago = (min: number): string => new Date(NOW.getTime() - min * 60_000).toISOString();
const PULLS = 3000;
const RUNS = 3000;
const GUEST_ISSUES = 2000;
/** Generous: a scan of `event` per row takes seconds at these sizes, the index takes milliseconds. */
const BOUND_MS = 500;

// The queries as they were before the index fix: the bare column, no INDEXED BY.
const OLD_BUILD_YIELD_SQL = BUILD_YIELD_SQL.replace("q.number + 0", "q.number");
const OLD_SWEEP_SQL = SWEEP_ASSIGNED_SQL.replace(" INDEXED BY event_repo_kind_number_at", "").replace("issue.number + 0", "issue.number");

const dirs: string[] = [];
const apps: App[] = [];

async function seeded(pulls: number, runs: number, guestIssues: number): Promise<App> {
  const dir = await mkdtemp(join(tmpdir(), "stall-scans-"));
  dirs.push(dir);
  const app = createApp({ dataDir: dir, port: 0 });
  apps.push(app);
  const u = await createUser(app.db, { origin: "seed", trusted: true, username: "scout", email: "scout@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!u.ok) throw new Error(u.error);
  const admin = u.value.id;
  app.db.run("INSERT INTO repo (id, owner_id, name, visibility) VALUES ('pub', ?1, 'pub', 'public')", [admin]);
  app.db.run("INSERT INTO user (id, username, email, password_hash, is_agent) VALUES ('bot', 'bot', 'bot@forge.local', '', 1)");
  app.db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('guest', 'guest', 'guest@forge.local', '')");
  const issue = (id: string, n: number, kind: string, author: string, assignee: string | null): void => {
    app.db.run("INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, assignee_id, state, created_at) VALUES (?1, 'pub', ?2, ?3, 't', '', ?4, ?5, 'open', ?6)", [id, n, kind, author, assignee, ago(5000)]);
  };
  const assigned = (id: string, n: number, kind: string, actor: string): void => {
    app.db.run("INSERT INTO event (id, kind, repo_id, actor_id, payload, created_at) VALUES (?1, ?2, 'pub', ?3, ?4, ?5)", [id, `${kind}.assigned`, actor, JSON.stringify({ number: n }), ago(4000)]);
  };
  app.db.transaction(() => {
    for (let n = 1; n <= pulls; n++) {
      issue(`p${n}`, n, "pull", admin, null);
      app.db.run("INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, 'main', ?2, '', 'h')", [`p${n}`, `b${n}`]);
      app.db.run("INSERT INTO event (id, kind, repo_id, payload, created_at) VALUES (?1, 'pull.pushed', 'pub', ?2, ?3)", [`e${n}`, JSON.stringify({ number: n }), ago(100 + (n % 50))]);
    }
    for (let n = 1; n <= runs; n++) {
      app.db.run("INSERT INTO run (id, repo_id, kind, branch, state, reason, started_at, finished_at) VALUES (?1, 'pub', 'agent', ?2, 'ok', '', ?3, ?4)", [`r${n}`, `b${n}`, ago(120 + (n % 50)), ago(90 + (n % 50))]);
    }
    // Issues assigned to the agent that no run has served yet.
    let n = pulls;
    const next = (): number => ++n;
    for (let i = 0; i < guestIssues; i++) {
      const k = next();
      issue(`g${i}`, k, "issue", admin, "bot");
      assigned(`ga${i}`, k, "issue", "guest"); // a guest assigned it: skipped
    }
    const kept = next();
    issue("by-admin", kept, "issue", admin, "bot");
    assigned("ea1", kept, "issue", admin); // an admin assigned it: kept
    const crew = next();
    issue("by-crew", crew, "issue", admin, "bot"); // no event: the crew's own, kept
    const own = next();
    issue("own-pull", own, "pull", "bot", "bot"); // the agent's own pull: skipped
    const served = next();
    issue("served", served, "issue", admin, "bot");
    assigned("ea2", served, "issue", admin);
    app.db.run("INSERT INTO run (id, repo_id, issue_id, kind, state, reason) VALUES ('served-run', 'pub', 'served', 'agent', 'ok', 'assigned')");
    // The newest assignment decides: a guest's, then an admin's.
    const regained = next();
    issue("regained", regained, "issue", admin, "bot");
    assigned("ea3", regained, "issue", "guest");
    assigned("ea4", regained, "issue", admin);
  })();
  return app;
}

let big: App;
beforeAll(async () => {
  big = await seeded(PULLS, RUNS, GUEST_ISSUES);
});
afterAll(async () => {
  for (const a of apps) a.close();
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const planOf = (app: App, sql: string, args: (string | number)[]): string[] =>
  app.db.query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail);

const timed = <T>(f: () => T): { value: T; ms: number } => {
  const t = performance.now();
  const value = f();
  return { value, ms: performance.now() - t };
};

test("build yield reads event through its index, never a scan of event or a run per run", () => {
  const plan = planOf(big, BUILD_YIELD_SQL, [ago(1440), ago(0), 0]);
  expect(plan.filter((d) => /SCAN /.test(d))).toEqual([]);
  expect(plan.some((d) => d.includes("event_repo_kind_number_at"))).toBe(true);
  // The run side is a range search on (kind, finished_at). Which index answers it
  // (run_kind_finished, or a covering one that leads with the same columns) is the
  // planner's choice and changes as indexes are added; the shape is what matters.
  expect(plan.some((d) => /^SEARCH x USING (COVERING )?INDEX \w+ \(kind=\? AND finished_at>\? AND finished_at<\?\)/.test(d))).toBe(true);
});

test("build yield on thousands of runs answers within the bound and counts them all", () => {
  const { value, ms } = timed(() => readBuildYield(big.db, NOW, true));
  expect(value.finished).toBe(RUNS);
  expect(value.pushed).toBe(RUNS);
  expect(ms).toBeLessThan(BOUND_MS);
});

test("the old build-yield query and the new one return the same rows", async () => {
  const small = await seeded(40, 40, 0);
  const args = [ago(1440), ago(0), 0];
  const rows = (sql: string): unknown[] => small.db.query(sql).all(...args);
  expect(rows(BUILD_YIELD_SQL).length).toBe(40);
  expect(rows(BUILD_YIELD_SQL)).toEqual(rows(OLD_BUILD_YIELD_SQL));
});

test("the assigned sweep drives from the agent's issues and reads event through its index", () => {
  const plan = planOf(big, SWEEP_ASSIGNED_SQL, []);
  expect(plan.filter((d) => /SCAN (e|event|issue|run)\b/.test(d))).toEqual([]);
  expect(plan.some((d) => d.includes("issue_assignee"))).toBe(true);
  expect(plan.some((d) => d.includes("event_repo_kind_number_at"))).toBe(true);
  expect(plan.some((d) => /SEARCH run USING (COVERING )?INDEX run_(issue|agent_issue_latest)/.test(d))).toBe(true);
});

test("the assigned sweep skips guests, own pulls and served issues, and returns what the old query did", async () => {
  const small = await seeded(5, 5, 6);
  const ids = (sql: string): string[] => small.db.query<{ id: string }, []>(sql).all().map((r) => r.id).sort();
  expect(ids(SWEEP_ASSIGNED_SQL)).toEqual(["by-admin", "by-crew", "regained"]);
  expect(ids(SWEEP_ASSIGNED_SQL)).toEqual(ids(OLD_SWEEP_SQL));
});

test("the assigned sweep answers within the bound on a forge of guest-assigned issues", () => {
  const { value, ms } = timed(() => big.db.query<{ id: string }, []>(SWEEP_ASSIGNED_SQL).all());
  expect(value.map((r) => r.id).sort()).toEqual(["by-admin", "by-crew", "regained"]);
  expect(ms).toBeLessThan(BOUND_MS);
});
