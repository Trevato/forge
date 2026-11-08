/**
 * The writes of a conversation's agent, kept so a resumed turn does none
 * twice (#8254). Each is recorded before it runs and completed with its
 * answer. A turn the restart cut leaves its records marked `resumed`; the
 * same write sent again by the resumed turn is answered from its record —
 * once, so a deliberate repeat after that goes ahead. A fresh turn starts
 * with none. Plain data in and out; the door is `http/mcp.ts`.
 */

import type { Database } from "bun:sqlite";
import { sha256 } from "../kernel/hash.ts";
import { id } from "../kernel/id.ts";

/** The longest answer kept to tell a resumed turn what was done. */
export const RESULT_MAX = 4000;

/** The arguments as one string whatever the order of their keys. */
const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? `[${v.map(canonical).join(",")}]`
    : v !== null && typeof v === "object"
      ? `{${Object.entries(v)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`)
          .join(",")}}`
      : (JSON.stringify(v) ?? "null");

export const argsHash = (args: Record<string, unknown>): string => sha256(canonical(args));

/** How long a record is kept: a resume comes within minutes, so a day is far past it. */
export const KEEP_MS = 24 * 60 * 60 * 1000;

/** A write about to run: its record's id. Records past `KEEP_MS` go with it, so none outlives its conversation for long. */
export function recordWrite(db: Database, via: string, tool: string, args: Record<string, unknown>, now: number = Date.now()): string {
  const rid = id();
  db.query("DELETE FROM conversation_write WHERE created_at < ?1").run(new Date(now - KEEP_MS).toISOString());
  db.query("INSERT INTO conversation_write (id, via, tool, args_hash, created_at) VALUES (?1,?2,?3,?4,?5)").run(
    rid,
    via,
    tool,
    argsHash(args),
    new Date(now).toISOString(),
  );
  return rid;
}

/** The write ended: what it answered, kept for a resumed turn. */
export function completeWrite(db: Database, recordId: string, result: string): void {
  db.query("UPDATE conversation_write SET result = ?2 WHERE id = ?1").run(recordId, result.slice(0, RESULT_MAX));
}

/** The write failed: nothing was done, so nothing is kept to say it was. */
export function dropWrite(db: Database, recordId: string): void {
  db.query("DELETE FROM conversation_write WHERE id = ?1").run(recordId);
}

/** A fresh turn: the last turn's writes are history. */
/** How many writes this conversation's turn has recorded; a fresh turn starts at none. */
export function writesThisTurn(db: Database, via: string): number {
  return db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM conversation_write WHERE via = ?1").get(via)?.n ?? 0;
}

export function forgetWrites(db: Database, via: string): void {
  db.query("DELETE FROM conversation_write WHERE via = ?1").run(via);
}

/** The turn was cut: what it recorded is what its resumption must not repeat. */
export function carryWrites(db: Database, via: string): void {
  db.query("UPDATE conversation_write SET resumed = 1 WHERE via = ?1").run(via);
}

/**
 * The record of this write from the turn that was cut, claimed once: its
 * answer, or `null` as the answer when it began and never ended. Undefined
 * when the cut turn did not send it.
 */
export function claimDone(
  db: Database,
  via: string,
  tool: string,
  args: Record<string, unknown>,
): { result: string | null } | undefined {
  const row = db
    .query<{ id: string; result: string | null }, [string, string, string]>(
      "SELECT id, result FROM conversation_write WHERE via = ?1 AND tool = ?2 AND args_hash = ?3 AND resumed = 1 ORDER BY id LIMIT 1",
    )
    .get(via, tool, argsHash(args));
  if (row === null) return undefined;
  db.query("DELETE FROM conversation_write WHERE id = ?1").run(row.id);
  return { result: row.result };
}

/** The tools of writes this turn began and never recorded the end of: what a person is shown on resume. */
export function unended(db: Database, via: string): string[] {
  return db
    .query<{ tool: string }, [string]>("SELECT tool FROM conversation_write WHERE via = ?1 AND result IS NULL ORDER BY id")
    .all(via)
    .map((r) => r.tool);
}
