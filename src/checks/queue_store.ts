/**
 * The merge queue's state outside memory (#6611): each gate's candidate as
 * it was built (`queue_gate`), and the line's red marks by pull, head and
 * base (`queue_red`). A roll used to cost a gate round — the new process
 * planned the line from nothing and gated it again; with these it resumes
 * the candidate in flight, adopting its run or its verdict (`checks/queue.ts`).
 *
 * Plain rows in, plain records out; what is read back is checked here, the
 * boundary, so a row this build cannot read is no record at all.
 */

import type { Database } from "bun:sqlite";
import type { GateRecord, QueueStore, RecordedStep, Remembered } from "./queue.ts";
import type { GateReason } from "./gate_reason.ts";
import { keepGateResult } from "./gate_result.ts";
import type { FailedTest, GateTests } from "./gate_tests.ts";
import type { LandVerdict } from "./tiers.ts";

/** How long a gate's record is kept unresumed: past it, its line has long moved on. */
export const KEEP_GATE_MS = 24 * 3_600_000;

type Judged = Exclude<LandVerdict, { interrupted: true }>;

const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

interface GateRow {
  id: string;
  repo_id: string;
  run_id: string;
  base_oid: string;
  base_tree_oid: string;
  tip_oid: string;
  tree_oid: string;
  steps: string;
  started_at: string;
  verdict: string | null;
}

/** The queue's store over this database. */
export function queueStore(db: Database, now: () => Date = () => new Date()): QueueStore {
  return {
    began: (record) => beginGateRecord(db, record, now()),
    settled: (id, verdict) => settleGateRecord(db, id, verdict),
    forget: (id) => void db.query("DELETE FROM queue_gate WHERE id = ?1").run(id),
    gates: (repoId) => gateRecords(db, repoId),
    red: (repoId, pullId, mark) => keepRed(db, repoId, pullId, mark, now()),
    reds: (repoId) => redMarks(db, repoId),
    judged: (id, result) => keepGateResult(db, id, result, now()),
  };
}

/** Record a gate as it starts; records past `KEEP_GATE_MS` go. */
export function beginGateRecord(db: Database, record: GateRecord, now = new Date()): void {
  db.query("DELETE FROM queue_gate WHERE started_at < ?1").run(new Date(now.getTime() - KEEP_GATE_MS).toISOString());
  db.query(
    `INSERT OR REPLACE INTO queue_gate
       (id, repo_id, run_id, base_oid, base_tree_oid, tip_oid, tree_oid, steps, started_at, verdict)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)`,
  ).run(
    record.id,
    record.repoId,
    record.runId,
    record.baseOid,
    record.baseTreeOid,
    record.tipOid,
    record.treeOid,
    JSON.stringify(record.steps),
    record.startedAt,
  );
}

/** A gate answered with no line to act on it: its verdict waits in the record. */
export function settleGateRecord(db: Database, id: string, verdict: Judged): void {
  db.query("UPDATE queue_gate SET verdict = ?2 WHERE id = ?1").run(id, JSON.stringify(verdict));
}

/** The repository's recorded gates, oldest first; a row that does not read is left out. */
export function gateRecords(db: Database, repoId: string): GateRecord[] {
  const rows = db
    .query<GateRow, [string]>("SELECT * FROM queue_gate WHERE repo_id = ?1 ORDER BY started_at, id")
    .all(repoId);
  const out: GateRecord[] = [];
  for (const row of rows) {
    const record = gateOf(row);
    if (record !== undefined) out.push(record);
  }
  return out;
}

function gateOf(row: GateRow): GateRecord | undefined {
  const oids = [row.base_oid, row.base_tree_oid, row.tip_oid, row.tree_oid];
  if (!oids.every((o) => OID.test(o))) return undefined;
  const steps = stepsOf(row.steps);
  if (steps === undefined || steps.length === 0) return undefined;
  const verdict = row.verdict === null ? undefined : verdictOf(row.verdict);
  if (row.verdict !== null && verdict === undefined) return undefined;
  return {
    id: row.id,
    repoId: row.repo_id,
    runId: row.run_id,
    baseOid: row.base_oid,
    baseTreeOid: row.base_tree_oid,
    tipOid: row.tip_oid,
    treeOid: row.tree_oid,
    steps,
    startedAt: row.started_at,
    ...(verdict === undefined ? {} : { verdict }),
  };
}

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stepsOf(text: string): RecordedStep[] | undefined {
  const list = parsed(text);
  if (!Array.isArray(list)) return undefined;
  const steps: RecordedStep[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { pullId, headOid, baseOid, treeOid, commitOid } = item as Record<string, unknown>;
    if (typeof pullId !== "string" || pullId === "") return undefined;
    const oids = [headOid, baseOid, treeOid, commitOid];
    if (!oids.every((o) => typeof o === "string" && OID.test(o))) return undefined;
    steps.push({
      pullId,
      headOid: headOid as string,
      baseOid: baseOid as string,
      treeOid: treeOid as string,
      commitOid: commitOid as string,
    });
  }
  return steps;
}

function verdictOf(text: string): Judged | undefined {
  const v = parsed(text);
  if (typeof v !== "object" || v === null) return undefined;
  const { lands, reopen, comment, learn, reason } = v as Record<string, unknown>;
  if (lands === true) return { lands: true };
  if (lands !== false || reopen !== true || typeof comment !== "string") return undefined;
  if (!Array.isArray(learn) || !learn.every((f) => typeof f === "string")) return undefined;
  const why = reasonOf(reason);
  if (reason !== undefined && why === undefined) return undefined;
  const named = gateTestsOf((v as Record<string, unknown>)["tests"]);
  return {
    lands: false,
    reopen: true,
    comment,
    learn: learn as string[],
    ...(why === undefined ? {} : { reason: why }),
    ...(named === undefined ? {} : { tests: named }),
  };
}

/** A recorded red's tests (#6739), read back; undefined when they do not read. */
function gateTestsOf(v: unknown): GateTests | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { passed, failed, failing } = v as Record<string, unknown>;
  if (!Number.isSafeInteger(passed) || !Number.isSafeInteger(failed) || !Array.isArray(failing)) return undefined;
  const tests: FailedTest[] = [];
  for (const item of failing as unknown[]) {
    if (typeof item !== "object" || item === null) return undefined;
    const { name, file, errors } = item as Record<string, unknown>;
    if (typeof name !== "string" || !Array.isArray(errors) || !errors.every((l) => typeof l === "string")) return undefined;
    tests.push({ name, ...(typeof file === "string" ? { file } : {}), errors: errors as string[] });
  }
  return { passed: passed as number, failed: failed as number, failing: tests };
}

/** Why a recorded red went red (#5276), read back; undefined when it is not one. */
function reasonOf(v: unknown): GateReason | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { kind, failed } = v as Record<string, unknown>;
  if (kind === "tests") return Number.isInteger(failed) && (failed as number) >= 0 ? { kind, failed: failed as number } : undefined;
  if (kind === "typecheck" || kind === "check" || kind === "install" || kind === "setup" || kind === "timeout") return { kind };
  return undefined;
}

/** Mark a pull red at a head and base, in place of any mark it had; undefined clears it. */
export function keepRed(
  db: Database,
  repoId: string,
  pullId: string,
  mark: Remembered | undefined,
  now = new Date(),
): void {
  db.query("DELETE FROM queue_red WHERE pull_id = ?1").run(pullId);
  if (mark === undefined) return;
  db.query(
    "INSERT INTO queue_red (repo_id, pull_id, head_oid, base_oid, together, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).run(repoId, pullId, mark.head, mark.base, JSON.stringify(mark.together), new Date(mark.at ?? now.getTime()).toISOString());
}

/** The repository's red marks, by pull id. */
export function redMarks(db: Database, repoId: string): Map<string, Remembered> {
  const rows = db
    .query<{ pull_id: string; head_oid: string; base_oid: string; together: string; at: string }, [string]>(
      "SELECT pull_id, head_oid, base_oid, together, at FROM queue_red WHERE repo_id = ?1 ORDER BY at",
    )
    .all(repoId);
  const marks = new Map<string, Remembered>();
  for (const row of rows) {
    const together = parsed(row.together);
    const numbers =
      Array.isArray(together) && together.every((n) => Number.isSafeInteger(n)) ? (together as number[]) : [];
    marks.set(row.pull_id, { head: row.head_oid, base: row.base_oid, together: numbers, at: Date.parse(row.at) || 0 });
  }
  return marks;
}

/**
 * Whether the check lane is running a gate of `tipOid` now, in any process
 * on this database: its `check_gate` trace is open and younger than `maxMs`
 * (a trace a crash left open is no run).
 */
export function gateRunning(db: Database, tipOid: string, maxMs: number, now = new Date()): boolean {
  const since = new Date(now.getTime() - maxMs).toISOString();
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM check_gate WHERE commit_oid = ?1 AND finished_at IS NULL AND started_at >= ?2",
      )
      .get(tipOid, since)!.n > 0
  );
}

/** The verdict recorded for a gate, if it has one. */
export function recordedVerdict(db: Database, id: string): Judged | undefined {
  const row = db.query<{ verdict: string | null }, [string]>("SELECT verdict FROM queue_gate WHERE id = ?1").get(id);
  return row?.verdict == null ? undefined : verdictOf(row.verdict);
}

/** Whether a gate's record is still kept: gone once a line acted on it. */
export function gateRecorded(db: Database, id: string): boolean {
  return db.query<{ id: string }, [string]>("SELECT id FROM queue_gate WHERE id = ?1").get(id) !== null;
}
