/**
 * A mirrored pull as its origin currently shows it: the pull itself, its
 * reviewers' verdicts, and how its check stands.
 *
 * Two things bring it up to date and they share this one path: the origin's
 * webhook (`origins/hook.ts`) names a pull and it is re-read at once, and
 * the sync worker walks the open pulls each sweep, so a delivery that never
 * came is caught on the next. Nothing the webhook says is believed; it only
 * says where to look, and the origin is asked.
 */

import type { Database } from "bun:sqlite";
import { importIssue, importReviewStates } from "./import.ts";
import type { Provider } from "./types.ts";

/** The most pulls re-read per sweep. */
export const POLLED_PULLS = 20;

export type CheckWord = "green" | "red" | "running" | "none";

export interface OriginCheck {
  readonly word: CheckWord;
  readonly headOid: string;
  /** When the origin last answered. */
  readonly checkedAt: string;
}

/** How the origin said a pull's check stands, when it ever has. */
export function originCheckOf(db: Database, issueId: string): OriginCheck | undefined {
  const row = db
    .query<{ word: CheckWord; head_oid: string; checked_at: string }, [string]>(
      "SELECT word, head_oid, checked_at FROM origin_pull_check WHERE issue_id = ?1",
    )
    .get(issueId);
  return row ? { word: row.word, headOid: row.head_oid, checkedAt: row.checked_at } : undefined;
}

/**
 * Ask the origin about one pull and keep its answer. An origin that does not
 * answer leaves what was kept exactly as it was. Answers whether it spoke.
 */
export async function refreshOriginPull(
  ctx: { db: Database; repoId: string; actorId: string },
  provider: Provider,
  fullName: string,
  number: number,
  now: Date = new Date(),
): Promise<boolean> {
  const remote = await provider.getIssue(fullName, number);
  if (!remote.ok || remote.value.pull === undefined) return false;
  const imported = importIssue(ctx, remote.value);
  const states = await provider.listReviewStates(fullName, number);
  if (states.ok) importReviewStates(ctx, imported.issueId, states.value);
  if (provider.getPullCheck === undefined) return true;
  const check = await provider.getPullCheck(fullName, number);
  if (!check.ok) return false;
  ctx.db
    .query(
      `INSERT INTO origin_pull_check (issue_id, head_oid, word, checked_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (issue_id) DO UPDATE SET head_oid = ?2, word = ?3, checked_at = ?4`,
    )
    .run(imported.issueId, check.value.headOid, check.value.word, now.toISOString());
  return true;
}

/** A settled pull is still re-read this often, to catch a review that moved nothing else. */
export const SETTLED_REREAD_MS = 60 * 60 * 1000;

/**
 * The first half of the line both doors show: "Check on bob/app: passing".
 * The caller adds when the origin said so, in its own voice.
 */
export function originCheckLead(fullName: string, kept: OriginCheck, pullHead: string): string {
  const stale = kept.headOid !== "" && kept.headOid !== pullHead;
  return `Check on ${fullName === "" ? "the origin" : fullName}: ${
    stale ? "waiting for the new head" : CHECK_WORDS[kept.word]
  }`;
}

const CHECK_WORDS: Record<CheckWord, string> = {
  green: "passing",
  red: "failing",
  running: "running",
  none: "has not run",
};

/**
 * The poll: the open pulls of a mirror whose check is not settled (never
 * read, running, not yet run, or for an older head), plus any settled one
 * not read for an hour, least recently read first and at most
 * `POLLED_PULLS` — so a sweep costs a bounded number of origin requests.
 */
export async function refreshOpenPulls(
  ctx: { db: Database; repoId: string; actorId: string },
  provider: Provider,
  fullName: string,
  now: Date = new Date(),
): Promise<number> {
  const open = ctx.db
    .query<{ number: number }, [string, number, string]>(
      `SELECT i.number FROM issue i JOIN pull p ON p.issue_id = i.id
         LEFT JOIN origin_pull_check c ON c.issue_id = i.id
        WHERE i.repo_id = ?1 AND i.state = 'open' AND p.merged_at IS NULL
          AND (c.issue_id IS NULL OR c.word IN ('running', 'none')
               OR c.head_oid <> p.head_oid OR c.checked_at < ?3)
        ORDER BY COALESCE(c.checked_at, '') ASC, i.number DESC LIMIT ?2`,
    )
    .all(ctx.repoId, POLLED_PULLS, new Date(now.getTime() - SETTLED_REREAD_MS).toISOString());
  let spoke = 0;
  for (const { number } of open)
    if (await refreshOriginPull(ctx, provider, fullName, number)) spoke++;
  return spoke;
}
