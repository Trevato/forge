/** Rows the rule watcher reads (#7560): a repo with pulls, their check runs, gate results and flakes, written straight. */
import type { Database } from "bun:sqlite";
import { createIssue } from "../../src/core/issues.ts";
import { createRun } from "../../src/core/runs.ts";
import { id } from "../../src/kernel/id.ts";

let last = 0;
/** A clock that never repeats, so two runs seeded in one millisecond keep their order. */
export const tick = (): number => (last = Math.max(Date.now(), last + 1));

export const iso = (ms: number): string => new Date(ms).toISOString();

export function seedPull(db: Database, repoId: string, authorId: string, title = "a pull"): { id: string; number: number } {
  const made = createIssue(db, { repoId, authorId, title, body: "", kind: "pull" });
  if (!made.ok) throw new Error(made.error);
  return { id: made.value.id, number: made.value.number };
}

/** A finished pull check: `ok`, or `failed` naming the failing tests. */
export function seedCheck(db: Database, repoId: string, pullId: string, state: "ok" | "failed", names: string[] = [], at = tick()): string {
  const run = createRun(db, { repoId, kind: "check", issueId: pullId });
  db.query("UPDATE run SET state = ?2, check_detail = ?3, created_at = ?4, started_at = ?4, finished_at = ?5 WHERE id = ?1").run(
    run.id,
    state,
    state === "failed" ? JSON.stringify({ passed: 1, failed: names.length, names }) : "",
    iso(at),
    iso(at + 120_000),
  );
  return run.id;
}

/** Keeps one red gate; returns its check-lane run id, which a flake in that gate carries. */
export function seedGate(db: Database, repoId: string, pulls: number[], failing: { name: string; file?: string }[], at = Date.now(), minutes = 10): string {
  const gate = id();
  const runId = `gate-${gate}`;
  db.query(
    `INSERT INTO gate_result (id, repo_id, run_id, tip_oid, pulls, state, failed, tests, started_at, finished_at, duration_ms)
     VALUES (?1, ?2, ?3, 'abc', ?4, 'red', ?5, ?6, ?7, ?8, ?9)`,
  ).run(gate, repoId, runId, JSON.stringify(pulls), failing.length, JSON.stringify(failing.map((f) => ({ ...f, errors: [] }))), iso(at - minutes * 60_000), iso(at), minutes * 60_000);
  return runId;
}

export function seedFlake(db: Database, repoId: string, test: string, file: string, at = Date.now(), ms: number | null = null, runId = id()): void {
  db.query("INSERT INTO check_flake (id, repo_id, run_id, commit_oid, test, file, at, ms) VALUES (?1, ?2, ?3, 'abc', ?4, ?5, ?6, ?7)").run(id(), repoId, runId, test, file, iso(at), ms);
}
