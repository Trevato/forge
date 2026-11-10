/**
 * The meter — what each app used, in the two quantities a forge charges
 * for: time awake and bytes kept. The runtime (`apps/runtime.ts`) writes
 * it as environments start, sleep, wake and stop, and samples storage
 * hourly; the profit slider (#392) reads it.
 *
 * Two ledgers:
 * - `meter`: one row per awake interval of an environment — from the
 *   instant a process starts serving to the instant it sleeps, stops,
 *   crashes or the forge shuts down. An open interval carries `beat_at`,
 *   the last instant it was seen running; one still open at boot was cut
 *   short by a crash and is closed there, never left running.
 * - `storage`: one row per app per sample — the bytes of all its
 *   environments' `FORGE_APP_DATA` and of its bare repository.
 *
 * Units, stated once:
 * - awake time is seconds (wall clock, not CPU), summed over environments;
 * - storage is GB-hours: bytes × hours / 1e9 (decimal GB). A sample stands
 *   for the hour after it, or until the next sample if that comes sooner.
 *
 * Pure data: no authz, no events. `repo_id` is text, not a reference, so
 * removing an app does not erase what it used.
 */

import type { Database } from "bun:sqlite";
import { defect } from "../kernel/error.ts";

/** Where an environment ran: hardware the operator owns, or a cloud's. */
export type Placement = "owned" | "cloud";
export const PLACEMENTS: readonly Placement[] = ["owned", "cloud"];

/** How long one storage sample stands for, in milliseconds. */
export const SAMPLE_SPAN_MS = 3_600_000;

const iso = (ms: number): string => new Date(ms).toISOString();

/** An instant as milliseconds, or a defect: callers pass `toISOString()`. */
function instant(at: string): number {
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) defect("meter.bad_instant", `not an instant: ${at}`);
  return ms;
}

// ---- writing ----

/**
 * An environment began serving. Idempotent: while an interval is open for
 * the environment (a redeploy swapping one process for the next) nothing
 * new is opened — the app never stopped being awake. True when one opened.
 */
export function openAwake(
  db: Database,
  input: { repoId: string; env: string; placement: Placement; at: string },
): boolean {
  const at = iso(instant(input.at));
  return db.query(
    `INSERT OR IGNORE INTO meter (repo_id, env, placement, started_at, beat_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
  ).run(input.repoId, input.env, input.placement, at).changes > 0;
}

/** An environment stopped serving: close its open interval, if any. */
export function closeAwake(
  db: Database,
  input: { repoId: string; env: string; at: string },
): void {
  const at = iso(instant(input.at));
  db.query(
    `UPDATE meter SET ended_at = max(?3, started_at), beat_at = max(?3, started_at)
     WHERE repo_id = ?1 AND env = ?2 AND ended_at IS NULL`,
  ).run(input.repoId, input.env, at);
}

/** The forge is shutting down: every open interval ends now. */
export function closeAllAwake(db: Database, at: string): void {
  const now = iso(instant(at));
  db.query(
    `UPDATE meter SET ended_at = max(?1, started_at), beat_at = max(?1, started_at)
     WHERE ended_at IS NULL`,
  ).run(now);
}

/** Every open interval was seen running at `at`. */
export function beatAwake(db: Database, at: string): void {
  const now = iso(instant(at));
  db.query(
    `UPDATE meter SET beat_at = max(?1, beat_at) WHERE ended_at IS NULL`,
  ).run(now);
}

/**
 * At boot: an interval still open belongs to a forge that died without
 * shutting down. It ends at its last heartbeat — the last instant anyone
 * knew it ran. Returns how many were closed.
 */
export function closeOrphans(db: Database): number {
  return db
    .query(`UPDATE meter SET ended_at = beat_at WHERE ended_at IS NULL`)
    .run().changes;
}

/** One storage sample of one app, in bytes. */
export function recordStorage(
  db: Database,
  input: { repoId: string; dataBytes: number; repoBytes: number; at: string },
): void {
  const bytes = (n: number): number =>
    Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  db.query(
    `INSERT INTO storage (repo_id, data_bytes, repo_bytes, at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).run(
    input.repoId,
    bytes(input.dataBytes),
    bytes(input.repoBytes),
    iso(instant(input.at)),
  );
}

/** When storage was last sampled, if ever. */
export function lastStorageAt(db: Database): string | undefined {
  const row = db
    .query<{ at: string | null }, []>(`SELECT max(at) AS at FROM storage`)
    .get();
  return row?.at ?? undefined;
}

// ---- reading ----

export interface AppUsage {
  readonly repoId: string;
  /** Seconds awake in the range, every environment summed. */
  readonly awakeSeconds: number;
  /** The same seconds, by where they ran. */
  readonly awakeByPlacement: Readonly<Record<Placement, number>>;
  /** (data + repository bytes) × hours in the range / 1e9. */
  readonly gbHours: number;
}

interface IntervalRow {
  repo_id: string;
  placement: Placement;
  started_at: string;
  ended_at: string | null;
}

interface SampleRow {
  repo_id: string;
  data_bytes: number;
  repo_bytes: number;
  at: string;
}

/**
 * What each app used in [from, to): awake seconds and GB-hours. An
 * interval still open counts up to `now` (default: the clock), never past
 * it. Apps with nothing in the range are absent. Ordered by repo id.
 */
export function usageBetween(
  db: Database,
  from: string,
  to: string,
  now: string = new Date().toISOString(),
): AppUsage[] {
  return usageBins(db, [from, to], now)[0] ?? [];
}

/**
 * What each app used in each of the consecutive ranges [edges[i],
 * edges[i+1]) — the board's thirty days (#510) in one pass over the two
 * ledgers, with the same arithmetic as `usageBetween`, which is the one-bin
 * case: so a day's seconds and GB-hours are exactly what `usageBetween`
 * would say for that day. Edges must ascend; fewer than two is no bins.
 */
export function usageBins(
  db: Database,
  edges: readonly string[],
  now: string = new Date().toISOString(),
): AppUsage[][] {
  const at = edges.map(instant);
  const clock = instant(now);
  const bins = Math.max(0, at.length - 1);
  if (bins === 0) return [];
  const lo = at[0]!;
  const hi = at[bins]!;
  const tallies = Array.from({ length: bins }, () => new Map<string, { owned: number; cloud: number; gbHours: number }>());
  const entry = (bin: number, repoId: string) => {
    const apps = tallies[bin]!;
    let e = apps.get(repoId);
    if (e === undefined) {
      e = { owned: 0, cloud: 0, gbHours: 0 };
      apps.set(repoId, e);
    }
    return e;
  };
  /** Each bin's share of [start, end), in milliseconds, handed to `add`. */
  const spread = (start: number, end: number, add: (bin: number, ms: number) => void) => {
    for (let b = 0; b < bins; b++) {
      const s = Math.max(start, at[b]!);
      const e = Math.min(end, at[b + 1]!);
      if (e > s) add(b, e - s);
    }
  };
  if (hi > lo) {
    const intervals = db
      .query<IntervalRow, [string, string]>(
        `SELECT repo_id, placement, started_at, ended_at FROM meter
         WHERE started_at < ?2 AND (ended_at IS NULL OR ended_at > ?1)`,
      )
      .all(iso(lo), iso(hi));
    for (const row of intervals) {
      const end = row.ended_at === null ? clock : instant(row.ended_at);
      spread(instant(row.started_at), end, (b, ms) => {
        entry(b, row.repo_id)[row.placement] += ms / 1000;
      });
    }

    // A sample before `from` may still stand for part of the range.
    const samples = db
      .query<SampleRow, [string, string]>(
        `SELECT repo_id, data_bytes, repo_bytes, at FROM storage
         WHERE at >= ?1 AND at < ?2 ORDER BY repo_id, at`,
      )
      .all(iso(lo - SAMPLE_SPAN_MS), iso(hi));
    samples.forEach((row, i) => {
      const taken = instant(row.at);
      const next = samples[i + 1];
      const until = Math.min(
        taken + SAMPLE_SPAN_MS,
        next !== undefined && next.repo_id === row.repo_id ? instant(next.at) : Infinity,
      );
      spread(taken, until, (b, ms) => {
        entry(b, row.repo_id).gbHours += ((row.data_bytes + row.repo_bytes) * (ms / SAMPLE_SPAN_MS)) / 1e9;
      });
    });
  }

  return tallies.map((apps) =>
    [...apps.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([repoId, e]) => ({
        repoId,
        awakeSeconds: e.owned + e.cloud,
        awakeByPlacement: { owned: e.owned, cloud: e.cloud },
        gbHours: e.gbHours,
      })),
  );
}
