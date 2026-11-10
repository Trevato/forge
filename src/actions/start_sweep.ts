/**
 * The life of an unclaimed account (#10912): asleep after `SLEEP_DAYS`
 * (suspended, so its token and its app stop answering), archived after
 * `ARCHIVE_DAYS` (its repositories archived), never deleted. A claim wakes
 * all of it (`actions/claim.ts`). Run from the daily maintenance tick.
 */
import type { App } from "../app.ts";
import { setSuspended } from "../core/accounts.ts";
import { listReposOwnedBy, moveArchived } from "../core/repos.ts";
import { dueToArchive, dueToSleep, markArchived, markSlept } from "../core/starts.ts";

export function sweepStarts(app: App, now: Date = new Date()): { slept: number; archived: number } {
  const stamp = now.toISOString();
  let slept = 0;
  let archived = 0;
  for (const userId of dueToSleep(app.db, now)) {
    setSuspended(app.db, userId, stamp);
    app.db.query("DELETE FROM token WHERE user_id = ?1").run(userId);
    markSlept(app.db, userId, now);
    slept++;
  }
  for (const userId of dueToArchive(app.db, now)) {
    for (const repo of listReposOwnedBy(app.db, userId)) moveArchived(app.db, repo.id, true, stamp);
    markArchived(app.db, userId, now);
    archived++;
  }
  if (slept + archived > 0) app.bus.append({ kind: "start.swept", payload: { slept, archived } });
  return { slept, archived };
}
