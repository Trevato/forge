/**
 * Routines that post into a Talk thread (#11011): the hourly forge check-in,
 * the friends watch and the morning paper. Each person has one row per kind
 * with an editable schedule: every N minutes, or once a day at an hour (UTC).
 * `due` is plain data in, plain boolean out; the runner is `crew/routines.ts`.
 */

import type { Database } from "bun:sqlite";
import { err, ok, type Result } from "../kernel/result.ts";
import { lastSlot } from "../nightly/slots.ts";

export const ROUTINE_KINDS = ["checkin", "friends", "paper"] as const;
export type RoutineKind = (typeof ROUTINE_KINDS)[number];

export const ROUTINE_NAMES: Readonly<Record<RoutineKind, string>> = {
  checkin: "Forge check-in",
  friends: "Friends watch",
  paper: "Morning paper",
};

export const EVERY_MIN = 15;
export const EVERY_MAX = 1440;

export interface Routine {
  readonly kind: RoutineKind;
  readonly enabled: boolean;
  readonly everyMin: number;
  /** UTC hour of a daily routine; null for one that runs every `everyMin`. */
  readonly atHour: number | null;
  readonly lastAt: string | null;
  readonly conversationId: string | null;
}

const DEFAULTS: Readonly<Record<RoutineKind, { everyMin: number; atHour: number | null }>> = {
  checkin: { everyMin: 60, atHour: null },
  friends: { everyMin: 180, atHour: null },
  paper: { everyMin: 1440, atHour: 7 },
};

interface Row {
  kind: RoutineKind;
  enabled: number;
  every_min: number;
  at_hour: number | null;
  last_at: string | null;
  conversation_id: string | null;
}

const of = (r: Row): Routine => ({ kind: r.kind, enabled: r.enabled === 1, everyMin: r.every_min, atHour: r.at_hour, lastAt: r.last_at, conversationId: r.conversation_id });

/** The person's three routines: stored rows, and the defaults for any not yet changed. Pure read. */
export function listRoutines(db: Database, userId: string): Routine[] {
  const rows = new Map(
    db
      .query<Row, [string]>("SELECT kind, enabled, every_min, at_hour, last_at, conversation_id FROM talk_routine WHERE user_id = ?1")
      .all(userId)
      .map((r) => [r.kind, r]),
  );
  return ROUTINE_KINDS.map((kind) => {
    const r = rows.get(kind);
    if (r !== undefined) return of(r);
    return { kind, enabled: true, everyMin: DEFAULTS[kind].everyMin, atHour: DEFAULTS[kind].atHour, lastAt: null, conversationId: null };
  });
}

export type RoutineError = "not_a_routine" | "bad_every" | "bad_hour";

/** Change a schedule: `hour` (0 to 23) makes it daily at that UTC hour; null makes it every `everyMin` minutes. */
export function setRoutine(
  db: Database,
  userId: string,
  kind: string,
  change: { readonly enabled: boolean; readonly everyMin: number; readonly atHour: number | null },
): Result<Routine, RoutineError> {
  if (!(ROUTINE_KINDS as readonly string[]).includes(kind)) return err("not_a_routine");
  if (!Number.isInteger(change.everyMin) || change.everyMin < EVERY_MIN || change.everyMin > EVERY_MAX) return err("bad_every");
  if (change.atHour !== null && (!Number.isInteger(change.atHour) || change.atHour < 0 || change.atHour > 23)) return err("bad_hour");
  db.query(
    "INSERT INTO talk_routine (user_id, kind, enabled, every_min, at_hour) VALUES (?1,?2,?3,?4,?5) ON CONFLICT (user_id, kind) DO UPDATE SET enabled = ?3, every_min = ?4, at_hour = ?5",
  ).run(userId, kind, change.enabled ? 1 : 0, change.everyMin, change.atHour);
  return ok(listRoutines(db, userId).find((r) => r.kind === kind)!);
}

/** Whether a routine is owed at `now`: never run, or its interval or its daily slot has passed since it last did. */
export function due(r: Pick<Routine, "enabled" | "everyMin" | "atHour" | "lastAt">, now: number): boolean {
  if (!r.enabled) return false;
  if (r.lastAt === null) return true;
  const last = Date.parse(r.lastAt);
  if (!Number.isFinite(last)) return true;
  if (r.atHour !== null) return last < lastSlot({ hour: r.atHour, minute: 0 }, now);
  return now - last >= r.everyMin * 60_000;
}

export function markRan(db: Database, userId: string, kind: RoutineKind, conversationId: string, now: Date): void {
  const d = DEFAULTS[kind];
  db.query(
    "INSERT INTO talk_routine (user_id, kind, every_min, at_hour, last_at, conversation_id) VALUES (?1,?2,?5,?6,?3,?4) ON CONFLICT (user_id, kind) DO UPDATE SET last_at = ?3, conversation_id = ?4",
  ).run(userId, kind, now.toISOString(), conversationId, d.everyMin, d.atHour);
}
