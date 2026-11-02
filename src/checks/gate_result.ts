/**
 * What each merge-queue gate found (#6739), one `gate_result` row a gate:
 * the pulls its candidate carried, green, red or cut off, why it went red,
 * how many tests passed and failed, the failing tests by name with the
 * first lines of their errors (`checks/gate_tests.ts`), and how long it
 * took. Before this a red gate said only a count, and nobody could say
 * which tests; `GET …/queue/gates` and the `queue_gates` MCP tool read it.
 *
 * A test is flaky when it failed in two red gates that share no pull: no
 * one pull's code explains both. Each failing test read back carries that
 * flag, worked out from the week the table keeps.
 *
 * Plain rows in, plain records out; what is read back is checked here, the
 * boundary, so a row this build cannot read loses only the part it cannot.
 */

import type { Database } from "bun:sqlite";
import type { FailedTest } from "./gate_tests.ts";
import { MAX_ERROR_LINES, MAX_FAILING } from "./gate_tests.ts";

/** How long a gate's result is kept. */
export const KEEP_RESULT_MS = 7 * 24 * 3_600_000;

/** The most red gates the flake check reads back: a busy week, bounded. */
const FLAKE_WINDOW = 500;

export type GateState = "green" | "red" | "cut_off";

/** A gate as it finished, to be kept. */
export interface GateResult {
  readonly repoId: string;
  /** The check lane's run id: `gate-` and the tip's first 12. */
  readonly runId: string;
  readonly tipOid: string;
  /** The pull numbers its candidate carried, in order. */
  readonly pulls: readonly number[];
  readonly state: GateState;
  /** Why it went red (`GateReason.kind`); none on green or cut off. */
  readonly reason?: string;
  readonly passed: number;
  readonly failed: number;
  readonly failing: readonly FailedTest[];
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** A failing test read back, flagged when a red gate sharing no pull failed it too. */
export interface FailingTest extends FailedTest {
  readonly flaky: boolean;
}

/** A kept gate as the API answers it. */
export interface KeptResult {
  readonly id: string;
  readonly runId: string;
  readonly tipOid: string;
  readonly pulls: readonly number[];
  readonly state: GateState;
  readonly reason: string | null;
  readonly passed: number;
  readonly failed: number;
  readonly failing: readonly FailingTest[];
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

interface Row {
  id: string;
  run_id: string;
  tip_oid: string;
  pulls: string;
  state: string;
  reason: string | null;
  passed: number;
  failed: number;
  tests: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
}

/** Keep one gate's result under `id`; results past `KEEP_RESULT_MS` go. */
export function keepGateResult(db: Database, id: string, result: GateResult, now = new Date()): void {
  db.query("DELETE FROM gate_result WHERE finished_at < ?1").run(new Date(now.getTime() - KEEP_RESULT_MS).toISOString());
  const failing = result.failing.slice(0, MAX_FAILING).map((t) => ({
    name: t.name,
    ...(t.file === undefined ? {} : { file: t.file }),
    errors: t.errors.slice(0, MAX_ERROR_LINES),
  }));
  const took = Math.max(0, Date.parse(result.finishedAt) - Date.parse(result.startedAt)) || 0;
  db.query(
    `INSERT OR REPLACE INTO gate_result
       (id, repo_id, run_id, tip_oid, pulls, state, reason, passed, failed, tests, started_at, finished_at, duration_ms)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  ).run(
    id,
    result.repoId,
    result.runId,
    result.tipOid,
    JSON.stringify(result.pulls),
    result.state,
    result.reason ?? null,
    Math.max(0, Math.trunc(result.passed)),
    Math.max(0, Math.trunc(result.failed)),
    JSON.stringify(failing),
    result.startedAt,
    result.finishedAt,
    took,
  );
}

/**
 * The repository's gates, newest first: at most `limit`, older than the
 * gate `before` names when it is given. Each failing test says whether it
 * is flaky.
 */
export function recentGates(db: Database, repoId: string, limit: number, before?: string): KeptResult[] {
  const n = Math.min(Math.max(Math.trunc(limit) || 20, 1), 100);
  const rows =
    before === undefined
      ? db
          .query<Row, [string, number]>("SELECT * FROM gate_result WHERE repo_id = ?1 ORDER BY id DESC LIMIT ?2")
          .all(repoId, n)
      : db
          .query<Row, [string, string, number]>(
            "SELECT * FROM gate_result WHERE repo_id = ?1 AND id < ?2 ORDER BY id DESC LIMIT ?3",
          )
          .all(repoId, before, n);
  if (rows.length === 0) return [];
  const flaky = flakyTests(redGates(db, repoId));
  return rows.map((row) => {
    const pulls = pullsOf(row.pulls);
    return {
      id: row.id,
      runId: row.run_id,
      tipOid: row.tip_oid,
      pulls,
      state: stateOf(row.state),
      reason: row.reason,
      passed: row.passed,
      failed: row.failed,
      failing: testsOf(row.tests).map((t) => ({ ...t, flaky: flaky.has(testKey(t)) })),
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
    };
  });
}

/** The repository's last red gates that named tests: their pulls and failing tests. */
export function redGates(db: Database, repoId: string): { pulls: number[]; failing: FailedTest[] }[] {
  return db
    .query<{ pulls: string; tests: string }, [string, number]>(
      "SELECT pulls, tests FROM gate_result WHERE repo_id = ?1 AND state = 'red' AND failed > 0 ORDER BY id DESC LIMIT ?2",
    )
    .all(repoId, FLAKE_WINDOW)
    .map((row) => ({ pulls: pullsOf(row.pulls), failing: testsOf(row.tests) }));
}

/** One test, in whichever gate: its file and its name. */
export function testKey(t: { readonly name: string; readonly file?: string }): string {
  return `${t.file ?? ""}\0${t.name}`;
}

/**
 * The tests that failed in two red gates sharing no pull (#6739): no one
 * pull's code explains both, so the test is flaky. By `testKey`.
 */
export function flakyTests(gates: readonly { pulls: readonly number[]; failing: readonly FailedTest[] }[]): Set<string> {
  const seen = new Map<string, (readonly number[])[]>();
  const flaky = new Set<string>();
  for (const gate of gates) {
    for (const t of gate.failing) {
      const key = testKey(t);
      const before = seen.get(key) ?? [];
      if (before.some((pulls) => !pulls.some((p) => gate.pulls.includes(p)))) flaky.add(key);
      before.push(gate.pulls);
      seen.set(key, before);
    }
  }
  return flaky;
}

function stateOf(text: string): GateState {
  return text === "green" || text === "red" ? text : "cut_off";
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function pullsOf(text: string): number[] {
  const list = parsed(text);
  return Array.isArray(list) ? list.filter((n): n is number => Number.isSafeInteger(n)) : [];
}

function testsOf(text: string): FailedTest[] {
  const list = parsed(text);
  if (!Array.isArray(list)) return [];
  const out: FailedTest[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const { name, file, errors } = item as Record<string, unknown>;
    if (typeof name !== "string") continue;
    const lines = Array.isArray(errors) ? errors.filter((l): l is string => typeof l === "string") : [];
    out.push({ name, ...(typeof file === "string" ? { file } : {}), errors: lines });
  }
  return out;
}
