/**
 * Release holds (#7557): while one stands, the keeper cuts nothing.
 *
 * - `failed`: a verify failed. It carries the version, the reason and the
 *   probe numbers. A pull that lands saying `release hold 4` is its cause —
 *   the hold by number, never the bare version, which changelogs and revert
 *   notes mention too. With a cause named the keeper may cut again; the
 *   hold is lifted when that release verifies.
 * - `owner`: an admin set it, with a reason; an admin lifts it.
 */

import type { Database } from "bun:sqlite";
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import { running } from "../kernel/version.ts";
import { mayRollBack } from "../release/gate.ts";

export type HoldKind = "failed" | "owner";

export interface Hold {
  readonly id: number;
  readonly kind: HoldKind;
  readonly version: string;
  readonly reason: string;
  readonly probes: number;
  readonly badInRow: number;
  readonly worstMs: number;
  readonly createdAt: string;
  readonly causePull: number | null;
  readonly liftedAt: string | null;
  readonly liftedBy: string | null;
}

interface Row {
  id: number;
  kind: HoldKind;
  version: string;
  reason: string;
  probes: number;
  bad_in_row: number;
  worst_ms: number;
  created_at: string;
  cause_pull: number | null;
  lifted_at: string | null;
  lifted_by: string | null;
}

const toHold = (r: Row): Hold => ({
  id: r.id,
  kind: r.kind,
  version: r.version,
  reason: r.reason,
  probes: r.probes,
  badInRow: r.bad_in_row,
  worstMs: r.worst_ms,
  createdAt: r.created_at,
  causePull: r.cause_pull,
  liftedAt: r.lifted_at,
  liftedBy: r.lifted_by,
});

/** A reason is one line a person reads: at most this long. */
export const MAX_REASON = 500;

export function setHold(
  db: Database,
  input: { kind: HoldKind; version: string; reason: string; probes?: number; badInRow?: number; worstMs?: number; at: number },
): Hold {
  const reason = input.reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_REASON);
  return toHold(
    db
      .query<Row, [string, string, string, number, number, number, string]>(
        `INSERT INTO keeper_hold (kind, version, reason, probes, bad_in_row, worst_ms, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) RETURNING *`,
      )
      .get(input.kind, input.version, reason, input.probes ?? 0, input.badInRow ?? 0, input.worstMs ?? 0, new Date(input.at).toISOString())!,
  );
}

/** The holds not lifted, oldest first. */
export function standingHolds(db: Database): Hold[] {
  return db.query<Row, []>(`SELECT * FROM keeper_hold WHERE lifted_at IS NULL ORDER BY id`).all().map(toHold);
}

/** What stops a cut, in one line; undefined when nothing does. A failed hold whose cause has landed lets the fix through. */
export function blocking(holds: readonly Hold[]): string | undefined {
  const h = holds.find((x) => x.kind === "owner" || x.causePull === null);
  if (h === undefined) return undefined;
  return h.kind === "owner"
    ? `the owner holds releases: ${h.reason}`
    : `${h.version} failed its verify (${h.reason}); waiting for a pull saying "release hold ${h.id}" to land`;
}

/** Does this pull's text say it is the hold's cause? Only `release hold N` does; a mere mention of the version does not. */
export function names(hold: Hold, text: string): boolean {
  return new RegExp(`(^|[^0-9a-z])release hold #?${hold.id}(?![0-9])`, "i").test(text);
}

export function setCause(db: Database, id: number, pull: number): void {
  db.query(`UPDATE keeper_hold SET cause_pull = ?2 WHERE id = ?1 AND cause_pull IS NULL`).run(id, pull);
}

export function lift(db: Database, id: number, by: string, at: number): boolean {
  return db.query(`UPDATE keeper_hold SET lifted_at = ?3, lifted_by = ?2 WHERE id = ?1 AND lifted_at IS NULL`).run(id, by, new Date(at).toISOString())
    .changes === 1;
}

/** A verified release lifts every failed hold whose cause has landed. */
export function liftFixed(db: Database, version: string, at: number): number {
  return db
    .query(`UPDATE keeper_hold SET lifted_at = ?2, lifted_by = ?1 WHERE kind = 'failed' AND cause_pull IS NOT NULL AND lifted_at IS NULL`)
    .run(`verified ${version}`, new Date(at).toISOString()).changes;
}

/** Every hold, newest first. */
export function listHolds(db: Database, limit = 20): Hold[] {
  return db.query<Row, [number]>(`SELECT * FROM keeper_hold ORDER BY id DESC LIMIT ?1`).all(limit).map(toHold);
}

export type OwnerHoldResult<T> = { ok: true; value: T } | { ok: false; error: "forbidden" | "invalid" | "not_found" | "refused"; message: string };

/**
 * An owner's hold, set by a person who may roll back (`release/gate.ts`):
 * the one function the MCP tool, the /releases card and the terminal call,
 * so the refusal, the sanitised reason and the event are the same in all
 * three. A refusal writes no hold and no event.
 */
export function holdAs(app: App, user: User | undefined, reason: string): OwnerHoldResult<Hold> {
  if (user === undefined || !mayRollBack(app, user))
    return { ok: false, error: "forbidden", message: "holding releases is for a person who may write the forge's repository and administer it, not an agent" };
  const clean = reason.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (clean === "" || clean.length > MAX_REASON) return { ok: false, error: "invalid", message: `reason is one line of 1 to ${MAX_REASON} characters` };
  const hold = setHold(app.db, { kind: "owner", version: running().version, reason: clean, at: Date.now() });
  app.bus.append({ kind: "release.held", actorId: user.id, payload: { hold: hold.id, reason: hold.reason, owner: true } });
  return { ok: true, value: hold };
}

/** Lift an owner's hold by id; a failed verify's hold is lifted only by a verified release. */
export function liftAs(app: App, user: User | undefined, id: number): OwnerHoldResult<number> {
  if (user === undefined || !mayRollBack(app, user))
    return { ok: false, error: "forbidden", message: "holding releases is for a person who may write the forge's repository and administer it, not an agent" };
  if (!Number.isInteger(id) || id < 1) return { ok: false, error: "invalid", message: "lift is a hold's id" };
  const hold = standingHolds(app.db).find((h) => h.id === id);
  if (hold === undefined) return { ok: false, error: "not_found", message: "no standing hold has that id" };
  if (hold.kind !== "owner")
    return { ok: false, error: "refused", message: "a failed verify's hold is lifted by a verified release after a pull saying \"release hold N\" lands" };
  lift(app.db, id, user.username, Date.now());
  app.bus.append({ kind: "release.hold_lifted", actorId: user.id, payload: { hold: id } });
  return { ok: true, value: id };
}
