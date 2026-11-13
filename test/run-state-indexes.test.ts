/** The questions about what is running and what is queued are answered from the state indexes, not a scan of run. */
import { expect, test } from "bun:test";
import { openDb } from "../src/kernel/db.ts";
import { migrations } from "../src/core/schema.ts";

const plan = (sql: string, ...args: (string | number)[]): string =>
  openedDb
    .query<{ detail: string }, (string | number)[]>(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...args)
    .map((r) => r.detail)
    .join("\n");

const openedDb = openDb(":memory:", migrations);

test("running, queued and stopped-beating questions use run_running and run_queued", () => {
  expect(plan(`SELECT COUNT(*) FROM run WHERE kind = 'agent' AND state = 'running'`)).toMatch(/run_running|run_kind_state/);
  expect(plan(`SELECT COUNT(*) AS n FROM run WHERE kind = 'check' AND state = 'queued'`)).toContain("run_queued");
  expect(plan(`SELECT kind, COUNT(*), MIN(created_at) FROM run WHERE state = 'queued' AND (not_before IS NULL OR not_before <= ?1) GROUP BY kind`, "x")).toContain("run_queued");
  expect(plan(`SELECT * FROM run WHERE kind = 'check' AND state = 'running' AND (heartbeat_at IS NULL OR heartbeat_at < ?1)`, "x")).toContain("run_running");
});
