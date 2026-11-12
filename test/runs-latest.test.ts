/**
 * The apps shelf reads each repository's newest agent run (#8379): one seek
 * per repository into `run_agent_latest`, the same answer the window over
 * every agent run gave, ties included. The cost is bounded by work, not a
 * clock (#7824): one statement for the whole shelf, and a plan that seeks the
 * index with no sort, so it does not grow with a repository's run count.
 */
import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { LATEST_AGENT_RUNS_SQL, latestAgentRunsForRepos } from "../src/core/runs.ts";
import { migrations } from "../src/core/schema.ts";
import { openDb } from "../src/kernel/db.ts";
import { statements } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";

/** The query the shelf ran before #8379, kept here as the oracle. */
function windowed(db: Database, repoIds: readonly string[]): Map<string, string> {
  const rows = db
    .query<{ id: string; repo_id: string }, string[]>(
      `SELECT id, repo_id FROM (
         SELECT run.*, ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY created_at DESC, id DESC) AS rn
         FROM run WHERE kind = 'agent' AND repo_id IN (${repoIds.map((_, n) => `?${n + 1}`).join(",")})
       ) WHERE rn = 1`,
    )
    .all(...repoIds);
  return new Map(rows.map((r) => [r.repo_id, r.id]));
}

function seeded(): { db: Database; repoIds: string[] } {
  const db = openDb(":memory:", migrations);
  db.run("INSERT INTO user (id, username, email, password_hash) VALUES ('u1','u','u@x','x')");
  const repoIds = Array.from({ length: 20 }, (_, i) => `r${String(i).padStart(2, "0")}`);
  const repo = db.prepare("INSERT INTO repo (id, owner_id, name) VALUES (?1, 'u1', ?1)");
  for (const id of repoIds) repo.run(id);
  const run = db.prepare("INSERT INTO run (id, repo_id, kind, created_at) VALUES (?1, ?2, ?3, ?4)");
  const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
  db.transaction(() => {
    // 5,000 agent runs on one repository, with deploys and checks between them.
    for (let n = 0; n < 5000; n++) {
      run.run(`a-${String(n).padStart(5, "0")}`, "r00", "agent", at(n));
      if (n % 10 === 0) run.run(`d-${n}`, "r00", "deploy", at(n + 10_000));
    }
    // Two agent runs at the same instant: the larger id wins, as before.
    run.run("t-a", "r01", "agent", at(5));
    run.run("t-b", "r01", "agent", at(5));
    run.run("t-0", "r01", "agent", at(1));
    // A newer check never stands in for the newest agent run.
    run.run("c-1", "r02", "agent", at(1));
    run.run("c-2", "r02", "check", at(9));
    // r03 has only a deploy; r04..r19 one or two agent runs each.
    run.run("d-only", "r03", "deploy", at(3));
    for (let i = 4; i < 20; i++) {
      run.run(`x-${i}-1`, repoIds[i]!, "agent", at(i));
      if (i % 2 === 0) run.run(`x-${i}-0`, repoIds[i]!, "agent", at(i - 1));
    }
  })();
  return { db, repoIds };
}

test("the newest agent run of each repository is the one the window picked, ties included", () => {
  const { db, repoIds } = seeded();
  const got = latestAgentRunsForRepos(db, repoIds);
  expect(new Map([...got].map(([repo, r]) => [repo, r.id]))).toEqual(windowed(db, repoIds));
  expect(got.get("r00")?.id).toBe("a-04999");
  expect(got.get("r01")?.id).toBe("t-b");
  expect(got.get("r02")?.id).toBe("c-1");
  expect(got.has("r03")).toBe(false);
  expect(latestAgentRunsForRepos(db, [])).toEqual(new Map());
  expect(latestAgentRunsForRepos(db, ["r01", "r01", "nope"]).size).toBe(1);
});

test("the read is one statement that seeks run_agent_latest, however many runs", async () => {
  const { db, repoIds } = seeded();
  const plan = db
    .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${LATEST_AGENT_RUNS_SQL}`)
    .all(JSON.stringify(repoIds))
    .map((r) => r.detail)
    .join("\n");
  expect(plan).not.toContain("TEMP B-TREE");
  expect(plan).toContain("COVERING INDEX run_agent_latest (repo_id=?)");
  expect(plan).not.toContain("SCAN r");
  expectWork(await statements(db, () => void latestAgentRunsForRepos(db, repoIds)), { max: 1 });
  // The statement explained above is the one the function runs, not a copy.
  const ran: string[] = [];
  const door = db as unknown as { query: (sql: string) => unknown };
  const original = db.query.bind(db);
  door.query = (sql: string) => (ran.push(sql), original(sql));
  try {
    latestAgentRunsForRepos(db, repoIds);
  } finally {
    door.query = original;
  }
  expect(ran).toEqual([LATEST_AGENT_RUNS_SQL]);
});
