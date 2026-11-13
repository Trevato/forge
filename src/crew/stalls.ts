/**
 * A stall: a builder's run on an issue ended without a pull — declined, or
 * nothing pushed — and was not cut short by the provider or a restart
 * (#4073). The clock does not wait for a person to lift one:
 *
 * - The next tick parks it (`freeStalled` in `autonomy.ts`): a note with
 *   who stalled it and the run's last summary, and the assignee cleared, so
 *   any builder may pick it.
 * - The builder that stalled it does not pick it again within the hour,
 *   unless a person has said what to try since (`shunnedBy`): another
 *   builder tries it fresh.
 * - A second stall strikes it out like any second park (`parks.ts`) and it
 *   goes to the planner with every reason.
 */

import type { Database } from "bun:sqlite";
import { BY_CREW, DONE_LIKE, PARK_LIKE } from "../core/done_on_main.ts";
import type { Repo } from "../core/repos.ts";
import { PULL_STOPPED } from "../core/runs.ts";
import { getUserById } from "../core/users.ts";
import { speaksForCrew } from "./direct.ts";
import { interruptionOf } from "./interrupted.ts";

/** What every stall's park reason says, whoever writes it. */
export const NO_PULL = "run ended without a pull";

/** How long a builder that stalled an issue leaves it to the others. */
export const SHUN_MS = 60 * 60_000;

/**
 * Whether a run ended because its pull landed under it (#8481): the work is
 * on the base, so it is no stall, no park and no strike. "The pull closed"
 * (closed without landing) is not this.
 */
export function landedUnder(run: { readonly summary: string }): boolean {
  return run.summary === PULL_STOPPED[1];
}

/** Whether a finished run left its issue without a pull: not interrupted, not landed, no pull opened or updated. */
export function leftWithoutPull(run: { readonly state: string; readonly summary: string }): boolean {
  if (run.state !== "ok" && run.state !== "failed") return false;
  if (landedUnder(run)) return false;
  if (/opened pull #|updated pull #/.test(run.summary)) return false;
  return !(run.state === "failed" && interruptionOf(run.summary) !== undefined);
}

/** The park reason for a stall: who stalled it, and the run's last summary on one line. */
export function stallReason(who: string | undefined, summary: string): string {
  const said = summary.replace(/\s+/g, " ").trim();
  const cut = said.length > 300 ? `${said.slice(0, 299)}…` : said;
  return `${who === undefined ? "the" : `@${who}'s`} ${NO_PULL}: ${cut || "no summary"}`;
}

/**
 * The agents whose run on the issue stalled it within `SHUN_MS` of `now`,
 * and nobody who directs the crew has said what to try since. The crew's
 * own notes — a park, done on main — are not such a word.
 */
export function shunnedBy(db: Database, repo: Repo, issueId: string, now: Date): Set<string> {
  const since = new Date(now.getTime() - SHUN_MS).toISOString();
  const stalls = db
    .query<{ actor: string; at: string; state: string; summary: string }, [string, string]>(
      `SELECT actor_id AS actor, COALESCE(finished_at, created_at) AS at, state, summary FROM run
        WHERE issue_id = ?1 AND kind = 'agent' AND actor_id IS NOT NULL
          AND COALESCE(finished_at, created_at) > ?2`,
    )
    .all(issueId, since)
    .filter(leftWithoutPull);
  if (stalls.length === 0) return new Set();
  const words = db
    .query<{ id: string; at: string }, [string, string]>(
      `SELECT n.author_id AS id, n.created_at AS at FROM comment n
        WHERE n.issue_id = ?1 AND n.created_at > ?2 AND n.origin_author IS NULL
          AND n.body NOT LIKE '${PARK_LIKE}'
          AND NOT (n.body LIKE '${DONE_LIKE}' AND ${BY_CREW})`,
    )
    .all(issueId, since)
    .filter((w) => speaksForCrew(db, repo, getUserById(db, w.id)));
  return new Set(
    stalls.filter((r) => !words.some((w) => w.at > r.at)).map((r) => r.actor),
  );
}
