/**
 * The map at the size of trevato/forge answers fast (#8381): 3,000 closed and
 * 300 open issues, 600 edges and 10 pillars were one `map` phase of 2.5–3.6 s.
 * The forge's own /api/v1/repos/trevato/forge/map named the step: `asktolive`
 * took 1.8 s of it, for 992 pulls merged in the week and 644 production deploys,
 * each deploy recording every merged pull its commit contains. That shape is
 * seeded here. The page names each step of its read in Server-Timing; the
 * ask-to-live step stays under 100 ms (2 s before) and the whole read (`map`) under 300 ms,
 * measured warm on the same machine as the test.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedFixture, type Fixture, type Shape } from "../bench/map-home.ts";
import { getUserByName } from "../src/core/users.ts";
import { getRepo } from "../src/core/repos.ts";
import { id } from "../src/kernel/id.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { reachOf, repoGraph } from "../src/core/dependencies.ts";
import { clearMapCache } from "../src/web/map_cache.ts";
import { askToLiveFor } from "../src/web/ask_to_live.ts";
import { pillarView } from "../src/core/pillars.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const SHAPE: Shape = {
  repos: 3,
  bigIssues: 3_300,
  bigOpen: 300,
  bigGraph: 900,
  bigEdges: 600,
  bigPulls: 20,
  lanes: [3],
  privateLanes: 0,
  sealed: 2,
  runs: 3,
  comments: 15,
  events: 20_000,
};

const STEPS = [
  "map-graph",
  "map-ready",
  "map-blocked",
  "map-critical",
  "map-layout",
  "map-marks",
  "map-pillars",
  "map-ask",
  "map-shown",
  "map-words",
];

let dir = "";
let f: Fixture;
let servers: Servers;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "forge-map-speed-"));
  clearMapCache();
  f = await seedFixture(dir, SHAPE);
  const db = f.app.db;
  const owner = getUserByName(db, "keeper")!;
  const repo = getRepo(db, "keeper", "forge")!;
  // Ten pillar umbrellas, each waiting for three open issues.
  const open = db
    .query<{ id: string }, [string]>(
      "SELECT id FROM issue WHERE repo_id = ?1 AND state = 'open' AND kind = 'issue' AND sealed = 0 ORDER BY number LIMIT 30",
    )
    .all(repo.id);
  db.transaction(() => {
    for (let p = 1; p <= 10; p++) {
      const umbrella = id();
      const number = db
        .query<{ issue_seq: number }, [string]>(
          "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
        )
        .get(repo.id)!.issue_seq;
      db.query(
        `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'issue', ?4, '', ?5, 'open', 0, ?6, ?6)`,
      ).run(umbrella, repo.id, number, `P${p} Pillar ${p}: what it is for`, owner.id, new Date().toISOString());
      for (const o of open.slice((p - 1) * 3, p * 3))
        db.query("INSERT INTO issue_dependency (issue_id, blocked_by_id, actor_id) VALUES (?1, ?2, ?3)").run(umbrella, o.id, owner.id);
    }
  })();
  // A real forge writes long bodies: trevato/forge's issues carry several kB each.
  db.query("UPDATE issue SET body = ?1 WHERE repo_id = ?2").run("x".repeat(6_000), repo.id);
  seedWeek(db, repo.id, open.slice(0, 30).map((o) => o.id));
  servers = await serve(f.app);
}, 180_000);
/** The pulls of the week and the production deploys that carried them, as trevato/forge had them. */
const WEEK = { pulls: 992, deploys: 644 };

function seedWeek(db: Fixture["app"]["db"], repoId: string, served: string[]): void {
  const owner = getUserByName(db, "keeper")!;
  const T = Date.now();
  const at = (hoursAgo: number) => new Date(T - hoursAgo * 3_600_000).toISOString();
  const numbers = served.map(
    (sid) => db.query<{ number: number }, [string]>("SELECT number FROM issue WHERE id = ?1").get(sid)!.number,
  );
  const issue = db.query(
    `INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, sealed, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'pull', ?4, ?5, ?6, 'closed', 0, ?7, ?7)`,
  );
  const pull = db.query(
    `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
     VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
  );
  const run = db.query(
    `INSERT INTO run (id, repo_id, kind, env, state, serving_at, finished_at)
     VALUES (?1, ?2, 'deploy', 'production', 'ok', ?3, ?3)`,
  );
  const carry = db.query(
    "INSERT INTO deploy_pull (run_id, issue_id, pull_number, merged_oid) VALUES (?1, ?2, ?3, 'o')",
  );
  db.transaction(() => {
    const merged: { id: string; number: number }[] = [];
    const hours = 165;
    let next = 0;
    for (let d = 0; d < WEEK.deploys; d++) {
      const when = hours - ((d + 1) * hours) / WEEK.deploys;
      // The pulls merged before this deploy; it carries all of them, as a rev-list does.
      while (next < WEEK.pulls && hours - ((next + 1) * hours) / WEEK.pulls > when + 0.05) {
        const pid = id();
        const number = db
          .query<{ issue_seq: number }, [string]>(
            "UPDATE repo SET issue_seq = issue_seq + 1 WHERE id = ?1 RETURNING issue_seq",
          )
          .get(repoId)!.issue_seq;
        const mergedAt = at(hours - ((next + 1) * hours) / WEEK.pulls);
        issue.run(pid, repoId, number, `Land ${next}`, `Closes #${numbers[next % numbers.length]}\n\n${"x".repeat(2_000)}`, owner.id, mergedAt);
        pull.run(pid, `crew/${next}`, mergedAt, `oid${next}`);
        merged.push({ id: pid, number });
        next++;
      }
      const rid = id();
      run.run(rid, repoId, at(when));
      for (const m of merged) carry.run(rid, m.id, m.number);
    }
  })();
}

afterAll(() => {
  servers?.stop();
  f?.app.close();
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

test("the map of a forge the size of trevato/forge reads in under 300 ms, each step named", async () => {
  const hit = async () => {
    const res = await fetch(`${servers.url}/keeper/forge/map?view=graph`, { headers: { cookie: f.strangerCookie } });
    await res.text();
    expect(res.status).toBe(200);
    const phases = new Map<string, number>();
    for (const m of (res.headers.get("server-timing") ?? "").matchAll(/([a-z-]+);dur=([\d.]+)/g))
      phases.set(m[1]!, Number(m[2]));
    return phases;
  };
  await hit(); // cold: fills the layout cache
  const phases = await hit();
  for (const step of STEPS) expect(phases.has(step)).toBe(true);
  // The step that was 1.8 s on trevato/forge: one read of the deploys, a probe or two per pull.
  expect(phases.get("map-ask")!).toBeLessThan(100);
  expect(phases.get("map")!).toBeLessThan(300);
  // `map` is the sum of the named steps and a little glue, never more than they are.
  const named = STEPS.reduce((n, step) => n + phases.get(step)!, 0);
  expect(phases.get("map")!).toBeGreaterThanOrEqual(named - 1);
}, 60_000);

test("one graph's reach maps are built once, however many rankings ask", () => {
  const repo = getRepo(f.app.db, "keeper", "forge")!;
  const graph = repoGraph(f.app.db, repo.id, { sealed: true, lean: true });
  const first = reachOf(graph);
  expect(reachOf(graph)).toBe(first);
  expect(reachOf(graph).holds).toBe(first.holds);
  // A second graph is its own: nothing is shared across graphs.
  expect(reachOf(repoGraph(f.app.db, repo.id, { sealed: true, lean: true }))).not.toBe(first);
});

test("a lean graph draws the same map as a full one", () => {
  const repo = getRepo(f.app.db, "keeper", "forge")!;
  const full = repoGraph(f.app.db, repo.id, { sealed: true });
  const lean = repoGraph(f.app.db, repo.id, { sealed: true, lean: true });
  const strip = (g: typeof full) => g.issues.map(({ body: _b, ...rest }) => rest);
  expect(strip(lean)).toEqual(strip(full));
  expect(lean.edges).toEqual(full.edges);
});

test("the week's merges reach production: every pillar's ask-to-live is read, not skipped", () => {
  const repo = getRepo(f.app.db, "keeper", "forge")!;
  const view = pillarView(f.app.db, repo)!;
  const ask = askToLiveFor(f.app, repo, view, undefined);
  expect(ask.length).toBe(10);
  // Each pillar has merged work that went live, so each has a figure; none is skipped.
  for (const row of ask) expect(row.askToLive?.slowest.number).toBeGreaterThan(0);
});
