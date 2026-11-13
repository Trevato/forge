/**
 * The minute's clog tick (#6524): reads the flow, asks `clogOf` whether it is
 * clogged, steps the watch (`clogStep`) and acts on the one event: "started"
 * is told on the bus once, "cleared" puts `clogNote` on the bus once (the feed
 * and the terminal read it from there). The watch state lives in `clog_state`, so a restart reads where it
 * left off and never repeats either.
 */

import type { Database } from "bun:sqlite";
import { listEvents, type EventBus } from "../core/events.ts";
import { getRepo } from "../core/repos.ts";
import { createLog } from "../kernel/log.ts";
import { ownRepoPath } from "../kernel/own_repo.ts";
import { CLOG_APPROVED_HOURS, clogOf } from "./clog.ts";
import { CLOG_NOTE_WINDOW_MS, clogNote, flattenNote } from "./clog_note.ts";
import { clogStep, type ClogEvent, type ClogState } from "./clog_watch.ts";
import { readOldestApproved } from "./oldest_approved.ts";
import { readStranded } from "./stranded.ts";
import { readVitals } from "./vitals.ts";
import { during } from "../perf/jobs.ts";

const HOUR_MS = 3_600_000;
const log = createLog("clog");

interface StateRow {
  since: number;
  first_reasons: string;
  quiet: number;
  peak_usd: number;
  started_at: number;
}

export function loadClog(db: Database): ClogState | null {
  const row = db.query<StateRow, []>("SELECT since, first_reasons, quiet, peak_usd, started_at FROM clog_state WHERE id = 1").get();
  if (!row) return null;
  let firstReasons: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.first_reasons);
    if (Array.isArray(parsed)) firstReasons = parsed.filter((r): r is string => typeof r === "string");
  } catch {
    // A row we cannot read is a clog with no recorded cause.
  }
  return { since: row.since, firstReasons, ...(row.started_at > 0 ? { startedAt: row.started_at } : {}), ...(row.quiet > 0 ? { quiet: row.quiet } : {}), peakUsd: row.peak_usd };
}

function saveClog(db: Database, state: ClogState | null): void {
  if (!state) {
    db.query("DELETE FROM clog_state WHERE id = 1").run();
    return;
  }
  db.query(
    `INSERT INTO clog_state (id, since, first_reasons, quiet, peak_usd, started_at) VALUES (1, ?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (id) DO UPDATE SET since = ?1, first_reasons = ?2, quiet = ?3, peak_usd = ?4, started_at = ?5`,
  ).run(state.since, JSON.stringify(state.firstReasons), state.quiet ?? 0, state.peakUsd ?? 0, state.startedAt ?? 0);
}

/** Pulls opened and landed over the last 2 h, forge-wide, as the clog thresholds read them. */
function twoHours(db: Database, now: Date): { opened: number; landed: number } {
  const from = new Date(now.getTime() - 2 * HOUR_MS).toISOString();
  const to = now.toISOString();
  const row = db
    .query<{ opened: number; landed: number }, [string, string]>(
      `SELECT
         (SELECT COUNT(*) FROM pull p JOIN issue i ON i.id = p.issue_id
           WHERE i.created_at >= ?1 AND i.created_at <= ?2) AS opened,
         (SELECT COUNT(*) FROM pull p JOIN repo r ON r.id = (SELECT repo_id FROM issue WHERE id = p.issue_id)
           WHERE p.base_branch = r.default_branch AND p.carried = 0 AND p.merged_at >= ?1 AND p.merged_at <= ?2) AS landed`,
    )
    .get(from, to);
  return { opened: row?.opened ?? 0, landed: row?.landed ?? 0 };
}

export interface ClogTick {
  readonly event: ClogEvent | null;
}

/** The newest cleared clog's note within a day, on one line: the terminal's door to what the feed shows. */
export function lastClearedNote(db: Database, now = new Date()): string | undefined {
  const [e] = listEvents(db, { kind: "clog.cleared", limit: 1 });
  const note = e?.payload["note"];
  if (typeof note !== "string" || now.getTime() - Date.parse(e!.createdAt) > CLOG_NOTE_WINDOW_MS) return undefined;
  return flattenNote(note);
}

/** Ticks once a minute; a tick that throws is logged and the next one runs. Returns the stop. */
export function startClogTick(
  db: Database,
  bus: Pick<EventBus, "append">,
  onError: (error: unknown) => void,
  everyMs = 60_000,
  prepare: () => void = () => {},
): () => void {
  const timer = setInterval(() => {
    try {
      during("clog", () => {
        prepare();
        tickClog(db, bus);
      });
    } catch (error) {
      onError(error);
    }
  }, everyMs);
  return () => clearInterval(timer);
}

/** One tick. With no own repository there is nobody to tell, and the watch still steps. */
export function tickClog(db: Database, bus: Pick<EventBus, "append">, now = new Date()): ClogTick {
  const vitals = readVitals(db, now);
  const { opened, landed } = twoHours(db, now);
  const oldest = readOldestApproved(db, now);
  const reading = clogOf({
    conflicted: vitals.conflicted,
    opened,
    landed,
    oldestApprovedHours: oldest ? Math.floor(oldest.hours) : 0,
  }).reasons;
  // When the oldest approved pull is what clogs, the clog began when it began to wait.
  const waited = oldest?.hours ?? 0;
  const startedAt = waited > CLOG_APPROVED_HOURS ? now.getTime() - waited * HOUR_MS : now.getTime();
  const [owner, name] = ownRepoPath().split("/");
  const repo = owner && name ? getRepo(db, owner, name) : undefined;
  // Read, step and write in one transaction: two overlapping processes cannot both clear.
  return db.transaction((): ClogTick => {
    const prev = loadClog(db);
    const step = clogStep(prev, reading, now.getTime(), startedAt);
    const usd = readStranded(db).usd;
    // The peak is the most seen while the clog stood: by the clear the pile is gone.
    const state = step.state && { ...step.state, peakUsd: Math.max(prev?.peakUsd ?? 0, usd) };
    if (JSON.stringify(state) !== JSON.stringify(prev)) saveClog(db, state);
    if (step.event === "cleared" && !repo) log.warn("clog cleared but the own repository is missing; no note posted");
    if (step.event === "cleared" && repo && prev) {
      const note = clogNote({
        reasons: prev.firstReasons,
        startedAt: prev.startedAt ?? prev.since,
        detectedAt: prev.since,
        clearedAt: now.getTime(),
        strandedUsd: Math.max(prev.peakUsd ?? 0, usd),
      });
      bus.append({ kind: "clog.cleared", repoId: repo.id, payload: { note, since: prev.since } });
    }
    if (step.event === "started" && repo) {
      bus.append({ kind: "clog.started", repoId: repo.id, payload: { since: now.getTime() } });
    }
    return { event: step.event };
  }).immediate();
}
