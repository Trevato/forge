/**
 * An adapter's `POST /pull` answer, judged and recorded (docs/ADAPTERS.md,
 * #10042). `parsePullAnswer` is the boundary: pure, given the status and the
 * raw body, it answers four checked fields or a failed pull with a short
 * reason naming what was wrong. `recordPull` writes the outcome as a run of
 * kind `pull` through `core/runs.ts`; `pullRunLines` reads them back for the
 * API (#10101), a page or MCP. Nothing here reaches the network: the
 * caller that sends the request and times it is `pull_schedule.ts` (#10043).
 */

import type { Database } from "bun:sqlite";
import { getAppById } from "../core/apps.ts";
import { EventBus } from "../core/events.ts";
import { createPullRun, lastPullCursor, lastPullState, listPullRuns, type PullRun } from "../core/runs.ts";

/** A body over this many bytes is a failed pull, never parsed. */
export const PULL_BODY_MAX = 64 * 1024;
/** Each count is an integer from 0 to this. */
export const PULL_COUNT_MAX = 1_000_000;
/** The cursor is at most this many characters (code points). */
export const PULL_CURSOR_MAX = 200;
/** A failed pull's reason is cut to this many characters. */
export const PULL_REASON_MAX = 200;

const FIELDS = ["pulled", "skipped", "cursor", "errors"] as const;
const COUNTS = ["pulled", "skipped", "errors"] as const;

/** What a repeat run's reason says. */
export const REPEAT_REASON = "same cursor as the last good pull: nothing new written";

export type PullAnswer =
  | {
      readonly ok: true;
      readonly pulled: number;
      readonly skipped: number;
      readonly errors: number;
      readonly cursor: string;
    }
  | { readonly ok: false; readonly reason: string };

/** An answer and how long the request took, as `recordPull` takes it. */
export type PullOutcome = PullAnswer & { readonly durationMs: number };

const fail = (reason: string): PullAnswer => ({ ok: false, reason: reason.slice(0, PULL_REASON_MAX) });

/**
 * Any control, format, private-use, unassigned or surrogate character, or a
 * line or paragraph separator: what "one line of printable characters" excludes.
 */
const NOT_PRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;

/** Whether `value` is a cursor the contract allows: one line, at most 200 printable characters. */
export function isPullCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    [...value].length <= PULL_CURSOR_MAX &&
    !NOT_PRINTABLE.test(value)
  );
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= PULL_COUNT_MAX;

/**
 * Judge one answer. A non-2xx status, a body over 64 KB, a body that is not a
 * JSON object of exactly `pulled`, `skipped`, `cursor` and `errors`, or any
 * field outside its rule is a failed pull, and the reason names the first
 * thing wrong — in a fixed order, so the same body always gives the same one.
 */
export function parsePullAnswer(status: number, body: string): PullAnswer {
  if (!Number.isInteger(status) || status < 200 || status > 299) {
    return fail(`status ${Number.isInteger(status) ? status : "unknown"} is not 2xx`);
  }
  if (Buffer.byteLength(body, "utf8") > PULL_BODY_MAX) {
    return fail(`body is over ${PULL_BODY_MAX} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return fail("body is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("body is not a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  const extra = keys.find((k) => !(FIELDS as readonly string[]).includes(k));
  if (extra !== undefined) return fail(`unexpected field ${JSON.stringify(extra.slice(0, 40))}`);
  const missing = FIELDS.find((f) => !Object.hasOwn(record, f));
  if (missing !== undefined) return fail(`${missing} is missing`);
  for (const field of COUNTS) {
    if (!isCount(record[field])) return fail(`${field} is not an integer from 0 to ${PULL_COUNT_MAX}`);
  }
  if (!isPullCursor(record.cursor)) {
    return fail(`cursor is not one line of at most ${PULL_CURSOR_MAX} printable characters`);
  }
  return {
    ok: true,
    pulled: record.pulled as number,
    skipped: record.skipped as number,
    errors: record.errors as number,
    cursor: record.cursor,
  };
}

/** A duration the table accepts: a whole, non-negative number of milliseconds. */
const durationOf = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0);

/**
 * Record one pull as a run. A failed answer keeps its reason and no cursor, so
 * the last good cursor stays where the next pull starts. A good answer whose
 * cursor equals the last good pull's is a repeat: it is recorded, with its
 * `pulled` counted as skipped and nothing written, so the same records never
 * count as written twice. A failed pull after an ok one (or the first) also
 * appends one `adapter.sync_failed` event, after the transaction commits, so
 * a live viewer never hears of a run that rolled back; repeats and recoveries
 * append none. The read and the write are one transaction, so two recordings
 * of the same answer cannot both see a fresh cursor.
 */
export function recordPull(
  db: Database,
  appId: string,
  outcome: PullOutcome,
  bus: Pick<EventBus, "append"> = new EventBus(db),
): PullRun {
  const durationMs = durationOf(outcome.durationMs);
  let speak: { repoId: string; reason: string } | undefined;
  const run = db.transaction((): PullRun => {
    if (!outcome.ok) {
      // Only the turn from ok (or from nothing) to failed speaks.
      const record = lastPullState(db, appId) !== "failed" ? getAppById(db, appId) : undefined;
      const reason = outcome.reason.slice(0, PULL_REASON_MAX);
      if (record !== undefined) speak = { repoId: record.repoId, reason };
      return createPullRun(db, {
        appId,
        state: "failed",
        written: 0,
        skipped: 0,
        failed: 0,
        cursor: "",
        durationMs,
        reason,
        repeat: false,
      });
    }
    const repeat = lastPullCursor(db, appId) === outcome.cursor;
    return createPullRun(db, {
      appId,
      state: "ok",
      written: repeat ? 0 : outcome.pulled,
      skipped: repeat ? Math.min(PULL_COUNT_MAX, outcome.skipped + outcome.pulled) : outcome.skipped,
      failed: outcome.errors,
      cursor: outcome.cursor,
      durationMs,
      reason: repeat ? REPEAT_REASON : "",
      repeat,
    });
  }).immediate();
  if (speak !== undefined) {
    bus.append({
      // The literal stays a literal: the audience-coverage scan
      // (`core/event_audience.ts`) reads event kinds from `append` calls, and
      // a constant would hide this one from it.
      kind: "adapter.sync_failed",
      repoId: speak.repoId,
      payload: { appId, reason: speak.reason },
    });
  }
  return run;
}

/** How many runs `pullRunLines` answers when asked for none in particular, and at most. */
export const PULL_RUNS_DEFAULT = 20;
export const PULL_RUNS_MAX = 100;

/** One recorded pull, as a reader sees it: plain data, the same for the API, a page and MCP. */
export interface PullRunLine {
  readonly id: string;
  /** When it was recorded, ISO 8601. */
  readonly at: string;
  readonly durationMs: number;
  readonly state: "ok" | "failed";
  /** The sentence saying why it failed; null when it did not. */
  readonly error: string | null;
  /** Records written, skipped and failed by the adapter. */
  readonly written: number;
  readonly skipped: number;
  readonly failed: number;
  /** Where the next pull starts after this one; null after a failed pull. */
  readonly cursor: string | null;
  /** A good pull whose cursor matched the last one, so nothing counted as written. */
  readonly repeat: boolean;
}

/**
 * An app's last pull runs, newest first: `limit` is clamped to 1–100. Whoever
 * calls this has already decided the reader may see the app.
 */
export function pullRunLines(db: Database, appId: string, limit = PULL_RUNS_DEFAULT): PullRunLine[] {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(PULL_RUNS_MAX, Math.trunc(limit))) : PULL_RUNS_DEFAULT;
  return listPullRuns(db, appId, n).map((run) => ({
    id: run.id,
    at: run.createdAt,
    durationMs: run.durationMs,
    state: run.state,
    error: run.state === "failed" ? run.reason : null,
    written: run.written,
    skipped: run.skipped,
    failed: run.failed,
    cursor: run.state === "failed" ? null : run.cursor,
    repeat: run.repeat,
  }));
}
