/**
 * Watching a milestone (#732). A person presses Watch on a milestone once;
 * from then on its progress is one item in their feed (`feed/items.ts`) and
 * their phone is told once, when it lands (`crew/notify.ts`). One row per
 * person and issue, and nothing else is stored: what a watch says is read
 * from the plan each time (`milestones.ts`), as that person, so a watch on
 * a repository they can no longer read says nothing.
 *
 * A watch is the person's own, like what they dismissed or muted: it is not
 * an event, and nobody else is told of it.
 */

import type { Database } from "bun:sqlite";
import { lastOpened } from "./interactions.ts";
import { readPlan, type Milestone } from "./milestones.ts";
import { PILLAR_DAYS } from "./pillars.ts";
import { canRead, getReposByIds, type Repo } from "./repos.ts";
import type { User } from "./users.ts";

/** Start or stop watching; either way twice is the same as once. */
export function setWatch(
  db: Database,
  userId: string,
  issueId: string,
  on: boolean,
): void {
  if (on)
    db.query(
      "INSERT OR IGNORE INTO milestone_watch (user_id, issue_id) VALUES (?1, ?2)",
    ).run(userId, issueId);
  else
    db.query(
      "DELETE FROM milestone_watch WHERE user_id = ?1 AND issue_id = ?2",
    ).run(userId, issueId);
}

export function isWatching(
  db: Database,
  userId: string,
  issueId: string,
): boolean {
  return (
    db
      .query<{ n: number }, [string, string]>(
        "SELECT COUNT(*) AS n FROM milestone_watch WHERE user_id = ?1 AND issue_id = ?2",
      )
      .get(userId, issueId)!.n > 0
  );
}

/** A feed item's id for a milestone starts with this: its state follows. */
export const watchItemPrefix = (issueId: string): string =>
  `milestone:${issueId}:`;

/** How long a milestone that landed, or will not, stays worth saying. */
const SAID_FOR_MS = PILLAR_DAYS * 24 * 3_600_000;

/** One milestone a person watches, as it stands for them now. */
export interface Watched {
  readonly repo: Repo;
  readonly milestone: Milestone;
  /**
   * `landed`: its issue closed as done, or the last open issue beneath it
   * closed. `dropped` or `split`: it will not land as written. `moving`
   * otherwise.
   */
  readonly state: "moving" | "landed" | "dropped" | "split";
  /** When it came to that state; for one that moves, when it last did. */
  readonly at: string;
  /** When they began to watch. */
  readonly watchedAt: string;
  /** The pulls merged for it since they last opened it from their feed, or began to watch; newest first. */
  readonly merged: Milestone["merged"];
  /**
   * The feed item this is: one per milestone, renamed when it moves, so
   * what was dismissed stays so only until there is something new.
   */
  readonly itemId: string;
}

/**
 * What a person watches, read as them: nothing for a repository they
 * cannot read, an issue that is gone, or one that no longer waits for
 * anything. A milestone that landed or was closed more than a week ago is
 * left out: it has been said. One read for the watches, and one plan for
 * each repository that has any.
 */
export function watchedBy(
  db: Database,
  viewer: User,
  now: number = Date.now(),
): Watched[] {
  const rows = db
    .query<
      { issue_id: string; repo_id: string; number: number; created_at: string },
      [string]
    >(
      `SELECT w.issue_id, i.repo_id, i.number, w.created_at
         FROM milestone_watch w JOIN issue i ON i.id = w.issue_id
        WHERE w.user_id = ?1 ORDER BY w.created_at, w.issue_id`,
    )
    .all(viewer.id);
  if (rows.length === 0) return [];
  const repos = getReposByIds(
    db,
    rows.map((r) => r.repo_id),
  );
  const plans = new Map<string, ReturnType<typeof readPlan> | null>();
  const out: Watched[] = [];
  for (const row of rows) {
    const repo = repos.get(row.repo_id);
    if (repo === undefined) continue;
    if (!plans.has(repo.id))
      plans.set(
        repo.id,
        canRead(db, repo, viewer)
          ? readPlan(db, repo, { spend: false, now: new Date(now) })
          : null,
      );
    const milestone = plans.get(repo.id)?.milestone(row.number);
    if (milestone === undefined) continue;
    const { issue, weight } = milestone;
    const state: Watched["state"] =
      issue.state === "closed"
        ? issue.closeReason === "dropped" || issue.closeReason === "split"
          ? issue.closeReason
          : "landed"
        : weight.total > 0 && weight.open === 0
          ? "landed"
          : "moving";
    const at =
      (issue.state === "closed" ? issue.closedAt : null) ??
      milestone.merged[0]?.at ??
      weight.last ??
      row.created_at;
    if (state !== "moving" && now - Date.parse(at) > SAID_FOR_MS) continue;
    const prefix = watchItemPrefix(issue.id);
    const opened = lastOpened(db, viewer.id, prefix);
    const since =
      opened !== undefined && opened > row.created_at ? opened : row.created_at;
    out.push({
      repo,
      milestone,
      state,
      at,
      watchedAt: row.created_at,
      merged: milestone.merged.filter((pull) => pull.at > since),
      itemId:
        state === "moving"
          ? `${prefix}${weight.done}-${weight.total}`
          : `${prefix}${state}`,
    });
  }
  return out;
}

/**
 * The lines a person's phone hears about what they watch: one for each
 * milestone that landed after they began to watch it. Nothing for progress,
 * and nothing for one that was dropped or split — the feed says those. The
 * notifier sends each id once (`crew/notify.ts`).
 */
export function landedLines(
  db: Database,
  viewer: User,
  now: number = Date.now(),
): { id: string; line: string; items: readonly string[]; link: string }[] {
  return watchedBy(db, viewer, now)
    .filter((w) => w.state === "landed" && w.at > w.watchedAt)
    .map((w) => {
      const { done, total } = w.milestone.weight;
      return {
        id: w.itemId,
        line: `${w.repo.name}: “${w.milestone.name}” landed, ${done} of ${total} done`,
        items: [w.itemId],
        link: `/${w.repo.ownerName}/${w.repo.name}/milestones/${w.milestone.issue.number}`,
      };
    });
}
