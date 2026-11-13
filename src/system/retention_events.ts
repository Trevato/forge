/**
 * How long an `event` row is kept, and the batch that deletes what is past it (#12008).
 *
 * Every reader of `event`, and the oldest row it can reach:
 *
 * Windowed by age — the longest over a kind not KEPT decides KEEP_DAYS:
 * - `boards/sources.ts`: spawn timings by day over a board's range; the longest fixed one is 30d
 *   (`boards/store.ts` RANGES), and "all" reaches as far as the rule keeps.
 * - `flow/estimate_base.ts`: reopened issues, 90 days, and `core/team-metrics.ts`: reopens, 7 days —
 *   `issue.*`, KEPT at any age, so no window binds them.
 * - `web/pages/security.ts`: deleted repositories, 30 days (`repo.*`, KEPT).
 * - `web/studio/since.ts`: "since you were here", the digest window (days).
 * - `feed/items.ts`, `feed/quiet.ts`: the home feed, its newest 300 and a 24 h quiet window.
 * - `feed/affinity.ts`: a viewer's newest 200, weighed by a 7-day half-life.
 * - `actions/mail.ts`: mail ceiling notices, 24 h. `crew/stale_pulls.ts`: closes, 72 h.
 * - `crew/landed.ts`: comments since a pull merged (read when it merges).
 *
 * Feeds, audit views and replay cursors — they page back through every row, so the rule sets
 * their reach: they answer the window the rule keeps, and nothing they list newer than that changes:
 * - `core/events.ts` `listEvents`/`listEventsVisibleTo`, under the events page and
 *   `/api/v1/repos/…/events` (`core/events_page.ts`), the MCP `events` tool
 *   (`http/mcp/tools/events.ts`), the TUI events screen, the Atom feed (`web/feeds.ts`, newest
 *   200), the home timeline (`feed/timeline.ts`) and the SSE replay from Last-Event-ID
 *   (`http/sse.ts`): a cursor older than the rule resumes from the oldest row kept.
 * - `core/cloud_account.ts`: the newest cloud secret reads, an audit list.
 * - `core/webhooks.ts`: a hook's recent deliveries (they cascade with their event); a delivery
 *   still `pending` keeps its event, so a retry never loses what it sends.
 *
 * At any age — state read back out of the log, so these kinds are never pruned (KEPT):
 * - `issue.*`, `pull.*`: thread timelines (`web/pages/thread.ts`), assignees and blockers
 *   (`actions/issues.ts`, `crew/dispatch.ts`, `crew/stranded.ts`), team waits, reopen counts
 *   (`flow/read.ts`), splits (`core/issues.ts`, `core/limb_replan.ts`), merge closes
 *   (`web/studio/tell.ts`, `core/done_on_main.ts`), the gate (`core/gate_hold.ts`), last push
 *   to a pull (`flow/idle_pulls.ts`, `web/pages/flow-waiting.ts`).
 * - `repo.*`: detached forks (`actions/fork_chain.ts`), the vision kept (`web/pages/thread.ts`).
 * - `user.*`: how an account was made (`core/accounts.ts`).
 * - `push`: when a repository was last pushed (`core/listings.ts`, `core/repos.ts`,
 *   `core/fork_follow.ts`, `flow/alarm_stuck.ts`).
 * - `app.egress.*`: the grants an app holds (`actions/egress_grants.ts`).
 * - `keeper_*`, `forge_down`, `forge_up`: what the keeper said once, tried, or last saw
 *   (`maintain/keeper/*.ts`).
 * - `pinned.check`, `clog.cleared`, `webhook.failing`: the newest of each, or a streak's mark.
 * Newest-row readers (`web/map_cache.ts`, `spawn/clients.ts`) read MAX and never reach the old end.
 *
 * A new reader that reaches past the window names its kind in KEPT, or it is windowed.
 *
 * A third class is a wake-up: an event whose only reader is the live page or the redraw that
 * hears it as it is appended (`LIVE_KINDS`). `run.shard` patches a pull's checks line when a
 * shard of its check ends, `usage.delta` redraws the spend graph, `backup.progress` moves a
 * progress bar; none is listed, counted or replayed for what it said, so each lives `LIVE_KEEP_MS`
 * (long enough for a reconnecting page to replay what it missed) and not 30 days. On production
 * `run.shard` alone was 57% of `event`'s rows (1.38M of 2.40M), and every row costs ten index entries.
 */
import type { Database } from "bun:sqlite";

const DAY_MS = 86_400_000;
/**
 * The default window, in days; an admin moves it with the `retention.event_days` limit
 * (`settings/limits.ts`). 30: the longest fixed window a reader asks of an unkept kind (a
 * board's 30d range). It was 180 (#12008), which on a forge younger than 180 days trims
 * nothing, while `event` was 578 MB of a 4.6 GiB file (#12052).
 */
export const KEEP_DAYS = 30;
/** The default window, in milliseconds. */
export const KEEP_MS = KEEP_DAYS * DAY_MS;
/** One batch: small enough to hold the write lock for milliseconds. */
export const BATCH_ROWS = 5_000;
/** Rows deleted per transaction: 60 µs a row across the table's ten indexes warm, so about 1 ms. */
export const CHUNK_ROWS = 20;
/**
 * What one slice of the age rule walks: 200 rows took about 9 ms on a copy of production
 * (a thousand took 43 ms at the median and 56 at the worst), and `retention.ts` runs a slice
 * every twenty times as long as it took.
 */
export const TICK_ROWS = 200;
/** After a pass reaches rows inside the rule it rests: the next pass starts a day later. */
export const REST_MS = DAY_MS;

/** The kinds that are wake-ups, not history: what hears one hears it as it is appended. */
export const LIVE_KINDS: readonly string[] = ["run.shard", "usage.delta", "backup.progress"];
/** How long a wake-up is kept: a page that reconnects inside it still replays what it missed. */
export const LIVE_KEEP_MS = 6 * 3_600_000;
/** Rows one slice of the wake-up rule deletes at most, in one transaction (about 60 µs a row across ten indexes). */
export const LIVE_SLICE_ROWS = 400;
/** The time a slice may spend deleting; the clock is read every `LIVE_CHUNK` rows (60 µs a row warm, 500 µs a row on a leaf not yet read). */
export const LIVE_SLICE_MS = 10;
const LIVE_CHUNK = 20;

export const KEPT_PREFIXES: readonly string[] = ["issue.", "pull.", "repo.", "user.", "app.egress.", "keeper_"];
export const KEPT_KINDS: readonly string[] = ["push", "forge_down", "forge_up", "pinned.check", "clog.cleared", "webhook.failing"];

/** Whether a row of `kind` is kept at any age. */
export function keptKind(kind: string): boolean {
  return KEPT_KINDS.includes(kind) || KEPT_PREFIXES.some((p) => kind.startsWith(p));
}

type Pass = { after: number; restUntil: number };
const passes = new WeakMap<Database, Pass>();

/**
 * One batch: walks at most `rowCap` rows from where the last batch stopped, in `seq` order (the
 * order they were written, so oldest first), and deletes those older than `keepMs` (KEEP_MS unless the setting says otherwise) that no reader
 * reaches at any age. `more` is whether rows past the rule are still to walk; when a pass meets
 * a row inside the rule it ends and rests REST_MS before starting from the oldest again. `lockMs`
 * is the longest the delete held the write lock (one CHUNK_ROWS transaction).
 */
export function pruneEvents(
  db: Database,
  now: number,
  rowCap: number = BATCH_ROWS,
  keepMs: number = KEEP_MS,
  budgetMs: number = LIVE_SLICE_MS,
): { deleted: number; more: boolean; lockMs: number } {
  const cap = Math.max(1, Math.min(BATCH_ROWS, Math.floor(rowCap)));
  const pass = passes.get(db) ?? { after: 0, restUntil: 0 };
  passes.set(db, pass);
  if (now < pass.restUntil) return { deleted: 0, more: false, lockMs: 0 };
  const cutoff = new Date(now - keepMs).toISOString();
  const rows = db
    .query<{ seq: number; rowid: number; kind: string; created_at: string }, [number, number]>(
      "SELECT seq, rowid, kind, created_at FROM event WHERE seq > ?1 ORDER BY seq LIMIT ?2",
    )
    .all(pass.after, cap);
  const old: typeof rows = [];
  let reached = rows.length < cap;
  for (const row of rows) {
    if (row.created_at >= cutoff) {
      reached = true;
      break;
    }
    old.push(row);
  }
  const doomedRows = old.filter((r) => !keptKind(r.kind));
  const doomed = doomedRows.map((r) => r.rowid);
  let deleted = 0;
  let lockMs = 0;
  let ranOut = false;
  const sliceStarted = performance.now();
  // A chunk per transaction, so the write lock is never held for the whole batch; the clock is read
  // between chunks, and a slice out of its budget ends there and the pass goes on from the last row it took.
  for (let at = 0; at < doomed.length; at += CHUNK_ROWS) {
    const chunk = doomed.slice(at, at + CHUNK_ROWS);
    const started = performance.now();
    db.transaction(() => {
      // A delivery still pending keeps its event: the retry sends it.
      const pending = new Set(
        db
          .query<{ rowid: number }, []>(
            "SELECT e.rowid FROM webhook_delivery d JOIN event e ON e.id = d.event_id WHERE d.state = 'pending'",
          )
          .all()
          .map((r) => r.rowid),
      );
      const gone = pending.size === 0 ? chunk : chunk.filter((r) => !pending.has(r));
      // Counted from the list, not `changes`: that counts the deliveries cascading with them too.
      db.query<unknown, [string]>("DELETE FROM event WHERE rowid IN (SELECT value FROM json_each(?1))").run(JSON.stringify(gone));
      deleted += gone.length;
    })();
    lockMs = Math.max(lockMs, performance.now() - started);
    if (performance.now() - sliceStarted >= budgetMs && at + CHUNK_ROWS < doomed.length) {
      pass.after = doomedRows[at + chunk.length - 1]!.seq;
      ranOut = true;
      break;
    }
  }
  if (ranOut) return { deleted, more: true, lockMs };
  if (reached) {
    pass.after = 0;
    pass.restUntil = now + REST_MS;
    return { deleted, more: false, lockMs };
  }
  pass.after = old[old.length - 1]!.seq;
  return { deleted, more: true, lockMs };
}

/**
 * One slice of the wake-up rule: of each of `LIVE_KINDS`, its oldest rows by `seq` (the
 * (kind, seq) index reads them in place, never a scan), those past `keepMs` deleted, at most
 * `rowCap` in all in one transaction. Nothing is remembered between calls: what went is not
 * there to be read again, so a slice starts where the last one ended and a repeat is harmless.
 * `more` is whether a kind still has rows past the window; a row whose delivery is still pending is not offered, so a retry never loses what it sends.
 */
export function pruneLiveEvents(
  db: Database,
  now: number,
  rowCap: number = LIVE_SLICE_ROWS,
  keepMs: number = LIVE_KEEP_MS,
  budgetMs: number = LIVE_SLICE_MS,
): { deleted: number; more: boolean } {
  const cap = Math.max(1, Math.floor(rowCap));
  const cutoff = new Date(now - keepMs).toISOString();
  const oldest = db.query<{ rowid: number; created_at: string }, [string, number]>(
    `SELECT rowid, created_at FROM event
      WHERE kind = ?1 AND NOT EXISTS (SELECT 1 FROM webhook_delivery d WHERE d.event_id = event.id AND d.state = 'pending')
      ORDER BY seq LIMIT ?2`,
  );
  const doomed: number[] = [];
  let more = false;
  for (const kind of LIVE_KINDS) {
    const room = cap - doomed.length;
    if (room <= 0) {
      more = true;
      break;
    }
    const rows = oldest.all(kind, room);
    const old = rows.filter((r) => r.created_at < cutoff);
    for (const r of old) doomed.push(r.rowid);
    // A full page of old rows may have more behind it; a page that met a young row has not.
    if (old.length === rows.length && rows.length === room) more = true;
  }
  if (doomed.length === 0) return { deleted: 0, more };
  // In chunks, the clock read between them: a slice out of budget ends there and the next starts at the oldest left.
  const started = performance.now();
  let deleted = 0;
  db.transaction(() => {
    for (let at = 0; at < doomed.length; at += LIVE_CHUNK) {
      const chunk = doomed.slice(at, at + LIVE_CHUNK);
      db.query<unknown, [string]>("DELETE FROM event WHERE rowid IN (SELECT value FROM json_each(?1))").run(JSON.stringify(chunk));
      deleted += chunk.length;
      if (performance.now() - started >= budgetMs) {
        if (at + LIVE_CHUNK < doomed.length) more = true;
        break;
      }
    }
  })();
  return { deleted, more };
}
