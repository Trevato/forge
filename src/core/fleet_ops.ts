/**
 * The receipt of a fleet operation: one row for the operation (who, which
 * query, which action) and one per selected row (its value before, the
 * value asked for, and what happened). Pure data — who may act and what
 * acting does live in `actions/fleet.ts`.
 */

import type { Database } from "bun:sqlite";
import { transact } from "../kernel/db.ts";
import { id } from "../kernel/id.ts";

/** A row's value, as it is shown before → after: plain JSON. */
export type FleetValue = string | number | boolean | null | readonly (string | number)[];

export type RowOutcome = "ok" | "failed" | "refused" | "unchanged";

export interface OperationRow {
  readonly targetId: string;
  readonly repoId: string;
  /** The row in words: `owner/name`, `owner/name#12`, `run 01… on owner/name`. */
  readonly label: string;
  readonly before: FleetValue;
  readonly after: FleetValue;
  readonly outcome: RowOutcome;
  /** Why a row was refused, failed or left alone; empty when it went through. */
  readonly reason: string;
}

export interface Operation {
  readonly id: string;
  readonly actorId: string;
  readonly actorName: string;
  readonly query: string;
  readonly kind: "repo" | "run" | "issue";
  readonly verb: string;
  readonly value: FleetValue;
  readonly reversible: boolean;
  /** The operation this one reversed, when it is an undo. */
  readonly undoOf: string | null;
  /** The operation that reversed this one, once one has. */
  readonly undoneBy: string | null;
  readonly createdAt: string;
  readonly rows: readonly OperationRow[];
}

export type NewOperation = Omit<
  Operation,
  "id" | "actorName" | "undoneBy" | "createdAt"
>;

interface OperationRecord {
  id: string;
  actor_id: string;
  actor_name: string | null;
  query: string;
  kind: Operation["kind"];
  verb: string;
  value: string;
  reversible: number;
  undo_of: string | null;
  undone_by: string | null;
  created_at: string;
}

interface RowRecord {
  operation_id: string;
  target_id: string;
  repo_id: string;
  label: string;
  before: string;
  after: string;
  outcome: RowOutcome;
  reason: string;
}

const SELECT = `
  SELECT fleet_operation.*, user.username AS actor_name
  FROM fleet_operation LEFT JOIN user ON user.id = fleet_operation.actor_id`;

/** Write the receipt, rows and all, in one transaction. */
export function recordOperation(db: Database, input: NewOperation): Operation {
  const opId = id();
  transact(db, () => {
    db.query(
      `INSERT INTO fleet_operation
         (id, actor_id, query, kind, verb, value, reversible, undo_of, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    ).run(
      opId,
      input.actorId,
      input.query,
      input.kind,
      input.verb,
      JSON.stringify(input.value),
      input.reversible ? 1 : 0,
      input.undoOf,
    );
    const insert = db.query(
      `INSERT INTO fleet_operation_row
         (operation_id, position, target_id, repo_id, label, before, after, outcome, reason)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    );
    input.rows.forEach((row, n) =>
      insert.run(
        opId,
        n,
        row.targetId,
        row.repoId,
        row.label,
        JSON.stringify(row.before),
        JSON.stringify(row.after),
        row.outcome,
        row.reason,
      ),
    );
  });
  return getOperation(db, opId)!;
}

/**
 * Claim an operation for undoing before any row is touched: the UPDATE's
 * WHERE is the claim, so two undos of one operation cannot both run.
 * `releaseUndo` gives it back when the undo came to nothing.
 */
export function claimUndo(db: Database, operationId: string): boolean {
  return (
    db
      .query(
        "UPDATE fleet_operation SET undone_by = 'pending' WHERE id = ?1 AND undone_by IS NULL",
      )
      .run(operationId).changes > 0
  );
}

export function releaseUndo(db: Database, operationId: string): void {
  db.query(
    "UPDATE fleet_operation SET undone_by = NULL WHERE id = ?1 AND undone_by = 'pending'",
  ).run(operationId);
}

/** Point a claimed operation at the operation that reversed it. */
export function settleUndo(
  db: Database,
  operationId: string,
  undoneBy: string,
): void {
  db.query(
    "UPDATE fleet_operation SET undone_by = ?2 WHERE id = ?1 AND undone_by = 'pending'",
  ).run(operationId, undoneBy);
}

export function getOperation(
  db: Database,
  operationId: string,
): Operation | undefined {
  const op = db
    .query<OperationRecord, [string]>(`${SELECT} WHERE fleet_operation.id = ?1`)
    .get(operationId);
  if (!op) return undefined;
  const rows = db
    .query<RowRecord, [string]>(
      "SELECT * FROM fleet_operation_row WHERE operation_id = ?1 ORDER BY position",
    )
    .all(operationId);
  return toOperation(op, rows);
}

/** One actor's operations, newest first, without their rows. */
export function listOperations(
  db: Database,
  actorId: string,
  limit: number,
  before?: string,
): Operation[] {
  return db
    .query<OperationRecord, [string, string, number]>(
      `${SELECT} WHERE fleet_operation.actor_id = ?1 AND fleet_operation.id < ?2
       ORDER BY fleet_operation.id DESC LIMIT ?3`,
    )
    .all(actorId, before ?? "\u{10FFFF}", limit)
    .map((op) => toOperation(op, []));
}

/**
 * An actor's newest operation that is not an undo, of one kind, whose query
 * starts with `queryPrefix` and whose verb is one of `verbs`; asked of the
 * table by those columns, so any number of undos between never hides it.
 */
export function latestDecision(
  db: Database,
  actorId: string,
  where: { kind: string; queryPrefix: string; verbs: readonly string[] },
): Operation | undefined {
  const marks = where.verbs.map((_, i) => `?${i + 4}`).join(", ");
  const op = db
    .query<OperationRecord, (string | number)[]>(
      `${SELECT} WHERE fleet_operation.actor_id = ?1 AND fleet_operation.kind = ?2
         AND fleet_operation.undo_of IS NULL AND substr(fleet_operation.query, 1, length(?3)) = ?3
         AND fleet_operation.verb IN (${marks})
       ORDER BY fleet_operation.id DESC LIMIT 1`,
    )
    .get(actorId, where.kind, where.queryPrefix, ...where.verbs);
  return op === null || op === undefined ? undefined : toOperation(op, []);
}

function toOperation(op: OperationRecord, rows: RowRecord[]): Operation {
  return {
    id: op.id,
    actorId: op.actor_id,
    actorName: op.actor_name ?? "",
    query: op.query,
    kind: op.kind,
    verb: op.verb,
    value: JSON.parse(op.value) as FleetValue,
    reversible: op.reversible === 1,
    undoOf: op.undo_of,
    undoneBy: op.undone_by === "pending" ? null : op.undone_by,
    createdAt: op.created_at,
    rows: rows.map((r) => ({
      targetId: r.target_id,
      repoId: r.repo_id,
      label: r.label,
      before: JSON.parse(r.before) as FleetValue,
      after: JSON.parse(r.after) as FleetValue,
      outcome: r.outcome,
      reason: r.reason,
    })),
  };
}
