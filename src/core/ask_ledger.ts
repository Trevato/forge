/**
 * The asks ledger: each time something asked a person, and how it ended —
 * `acted` (they shipped, closed, answered), `dismissed`, or `expired` (its
 * cause went away with nobody acting). Raised against acted against
 * dismissed is how noise shows up as a number (`askMeasure`). Pure data:
 * what counts as an ask, and how one ended, is `web/studio/asks.ts`'s to say.
 */

import type { Database } from "bun:sqlite";
import { id } from "../kernel/id.ts";

export type AskEnd = "acted" | "dismissed" | "expired";

/** An ask as the ledger keeps it. */
export interface LedgerAsk {
  readonly id: string;
  readonly repoId: string;
  readonly kind: string;
}

/**
 * Bring one viewer's open rows in line with what asks them now. `shown` is
 * what they see; `all` adds what they dismissed. An open row whose ask is
 * in `all` but not `shown` ends `dismissed`; one in neither ends as
 * `endOf` says. An ask in `shown` with no open row is raised.
 */
export function syncAskLedger(
  db: Database,
  viewerId: string,
  all: readonly LedgerAsk[],
  shown: readonly LedgerAsk[],
  endOf: (askId: string, raisedAt: string) => Exclude<AskEnd, "dismissed">,
  now: string,
): void {
  const open = db
    .query<
      { id: string; ask_id: string; raised_at: string },
      [string]
    >("SELECT id, ask_id, raised_at FROM ask_ledger WHERE viewer_id = ?1 AND ended_at IS NULL")
    .all(viewerId);
  const allIds = new Set(all.map((a) => a.id));
  const shownIds = new Set(shown.map((a) => a.id));
  const end = db.query<unknown, [string, string, string]>(
    "UPDATE ask_ledger SET ended_at = ?2, ended_how = ?3 WHERE id = ?1",
  );
  const raise = db.query<
    unknown,
    [string, string, string, string, string, string]
  >(
    "INSERT INTO ask_ledger (id, viewer_id, ask_id, repo_id, kind, raised_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  );
  db.transaction(() => {
    const stillOpen = new Set<string>();
    for (const row of open) {
      if (shownIds.has(row.ask_id)) stillOpen.add(row.ask_id);
      else if (allIds.has(row.ask_id)) end.run(row.id, now, "dismissed");
      else end.run(row.id, now, endOf(row.ask_id, row.raised_at));
    }
    for (const a of shown)
      if (!stillOpen.has(a.id))
        raise.run(id(), viewerId, a.id, a.repoId, a.kind, now);
  })();
}

export interface AskMeasure {
  readonly raised: number;
  readonly acted: number;
  readonly dismissed: number;
  readonly expired: number;
}

/** What asked this viewer since `since`, and how what ended since then ended. */
export function askMeasure(
  db: Database,
  viewerId: string,
  since: string,
): AskMeasure {
  const raised =
    db
      .query<
        { n: number },
        [string, string]
      >("SELECT COUNT(*) AS n FROM ask_ledger WHERE viewer_id = ?1 AND raised_at >= ?2")
      .get(viewerId, since)?.n ?? 0;
  const ended = new Map(
    db
      .query<{ how: AskEnd; n: number }, [string, string]>(
        `SELECT ended_how AS how, COUNT(*) AS n FROM ask_ledger
         WHERE viewer_id = ?1 AND ended_at >= ?2 GROUP BY ended_how`,
      )
      .all(viewerId, since)
      .map((r) => [r.how, r.n]),
  );
  return {
    raised,
    acted: ended.get("acted") ?? 0,
    dismissed: ended.get("dismissed") ?? 0,
    expired: ended.get("expired") ?? 0,
  };
}

/** How this viewer's last asks on a repository ended, newest first: what they decided there. */
export function recentEnds(
  db: Database,
  viewerId: string,
  repoId: string,
  limit = 10,
): { kind: string; how: AskEnd; at: string }[] {
  return db
    .query<
      { kind: string; how: AskEnd; at: string },
      [string, string, number]
    >(
      `SELECT kind, ended_how AS how, ended_at AS at FROM ask_ledger
       WHERE viewer_id = ?1 AND repo_id = ?2 AND ended_at IS NOT NULL
       ORDER BY ended_at DESC, id DESC LIMIT ?3`,
    )
    .all(viewerId, repoId, limit);
}

/** The window the asks measure covers. */
export const ASKS_WINDOW_DAYS = 7;

/** The last `ASKS_WINDOW_DAYS` days of this viewer's asks: the one window both doors read. */
export function askMeasureWeek(db: Database, viewerId: string, now = Date.now()): AskMeasure {
  return askMeasure(db, viewerId, new Date(now - ASKS_WINDOW_DAYS * 86_400_000).toISOString());
}

/** The four figures of a measure with their labels, in the order they are said. */
export function asksMeasureParts(m: AskMeasure): readonly { n: number; label: string }[] {
  return [
    { n: m.raised, label: "raised" },
    { n: m.acted, label: "acted on" },
    { n: m.dismissed, label: "dismissed" },
    { n: m.expired, label: "went by themselves" },
  ];
}

/** True when nothing has asked and nothing has ended: the line is then not shown. */
export function asksMeasureEmpty(m: AskMeasure): boolean {
  return m.raised + m.acted + m.dismissed + m.expired === 0;
}

/** "Asks, 7 days: 4 raised · 2 acted on · 1 dismissed · 1 went by themselves" */
export function asksMeasureWords(m: AskMeasure): string {
  return `Asks, ${ASKS_WINDOW_DAYS} days: ${asksMeasureParts(m).map((p) => `${p.n} ${p.label}`).join(" · ")}`;
}
