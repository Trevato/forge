import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { LIVE_COST_FACTOR, LIVE_MIN_GAP_MS, liveDelay } from "../src/tui/screens/common.ts";
import hotIndexes from "../src/core/migrations/20261113190000-run-hot-indexes.ts";

test("after a quiet spell the screen refreshes at once; in a storm, once per gap", () => {
  expect(liveDelay(1_000_000, Number.NEGATIVE_INFINITY, 0)).toBe(40);
  expect(liveDelay(1_000_000, 1_000_000 - LIVE_MIN_GAP_MS - 1, 5)).toBe(40);
  expect(liveDelay(1_000_000, 1_000_000 - 500, 5)).toBe(LIVE_MIN_GAP_MS - 500);
});

test("a slow screen waits ten times what its last refresh cost", () => {
  expect(liveDelay(1_000_000, 1_000_000, 900)).toBe(900 * LIVE_COST_FACTOR);
});

test("the three hot questions of run are answered from an index, not a scan", () => {
  const db = new Database(":memory:");
  db.run("CREATE TABLE run (id TEXT PRIMARY KEY, repo_id TEXT, kind TEXT, state TEXT, env TEXT, started_at TEXT, created_at TEXT)");
  db.run(hotIndexes);
  const plan = (sql: string) =>
    db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
  expect(plan("SELECT COUNT(*) AS n FROM run INDEXED BY run_kind_state WHERE kind = 'check' AND state = 'queued'")).toContain("COVERING INDEX run_kind_state");
  expect(plan("SELECT DISTINCT repo_id FROM run INDEXED BY run_check_verify_repo WHERE kind = 'check' AND env = 'verify'")).toContain("COVERING INDEX run_check_verify_repo");
  expect(plan("SELECT MAX(COALESCE(started_at, created_at)) AS at FROM run INDEXED BY run_agent_last_start WHERE kind = 'agent'")).toContain("run_agent_last_start");
});
