/**
 * The week's figures for a repository, read from the standing and the
 * ledger and handed to the pure policy in `week.ts` (#8695).
 */

import type { App } from "../app.ts";
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { standings, WINDOW_MS } from "../core/standing.ts";
import { grantedAccounts } from "../core/subscriptions.ts";
import { efficiencyWords, weekDecision, type Efficiency, type WeekDecision } from "./week.ts";

interface Week {
  readonly capUsd: number;
  readonly usedUsd: number;
  readonly resetsAt: Date;
}

/** How long a repository's week is remembered: `repoPace` is asked many times a tick. */
const REMEMBER_MS = 5_000;
const remembered = new Map<string, { at: number; week: Week | null }>();

/** Forget what was remembered, so the next ask reads again. */
export function forgetWeek(): void {
  remembered.clear();
}

/** The week's capacity and spend over the repository's accounts; null while no account's week has a known cap. */
function weekOf(app: App, repo: Repo, now: Date): Week | null {
  const key = `${app.config.dataDir}\0${repo.id}`;
  const hit = remembered.get(key);
  if (hit !== undefined && Math.abs(now.getTime() - hit.at) < REMEMBER_MS) return hit.week;
  const week = readWeek(app, repo, now);
  remembered.set(key, { at: now.getTime(), week });
  return week;
}

function readWeek(app: App, repo: Repo, now: Date): Week | null {
  const granted = grantedAccounts(app.db, repo.id, repo.ownerId);
  const stand = standings(app.db, granted.map((a) => a.id), now);
  let capUsd = 0;
  let usedUsd = 0;
  let resetsAt: number | null = null;
  for (const s of stand.values()) {
    const w = s.windows.find((x) => x.window === "week");
    if (w === undefined || w.cap === null || w.kept === null || w.resetsAt === null) continue;
    capUsd += Math.max(0, w.cap.value - w.kept.value);
    usedUsd += w.used.value;
    const at = Date.parse(w.resetsAt.value);
    if (resetsAt === null || at < resetsAt) resetsAt = at;
  }
  return resetsAt === null ? null : { capUsd, usedUsd, resetsAt: new Date(resetsAt) };
}

/** Real landings, agent runs and what they cost since `since`: carried pulls and pulls that added nothing are left out. */
export function efficiencySince(app: App, repo: Repo, since: Date): Efficiency {
  const at = since.toISOString();
  const landings =
    app.db
      .query<{ n: number }, [string, string]>(
        `SELECT COUNT(*) AS n FROM pull q JOIN issue i ON i.id = q.issue_id
          WHERE q.merged_at IS NOT NULL AND q.merged_at >= ?2 AND i.repo_id = ?1
            AND q.carried = 0 AND q.merged_oid != q.base_oid`,
      )
      .get(repo.id, at)?.n ?? 0;
  const runs = app.db
    .query<{ n: number; usd: number | null }, [string, string]>(
      `SELECT COUNT(*) AS n, SUM(cost_usd) AS usd FROM run
        WHERE repo_id = ?1 AND kind = 'agent' AND created_at >= ?2`,
    )
    .get(repo.id, at);
  return { landings, runs: runs?.n ?? 0, costUsd: runs?.usd ?? 0 };
}

/** The week's efficiency: since the week opened, or seven days back when no window is known. */
export function weekEfficiency(app: App, repo: Repo, now: Date): Efficiency {
  const week = weekOf(app, repo, now);
  const since = week === null ? now.getTime() - WINDOW_MS.week : week.resetsAt.getTime() - WINDOW_MS.week;
  return efficiencySince(app, repo, new Date(since));
}

/**
 * The week's decision for a repository, given the builders' idle slots and
 * the issues a builder may start and the Later gate alone holds; null while
 * the week's capacity is unknown.
 */
export function weekFor(
  app: App,
  repo: Repo,
  now: Date,
  seen: { idleSlots: number; startable: number; gated: number } = { idleSlots: 0, startable: 0, gated: 0 },
): WeekDecision | null {
  const week = weekOf(app, repo, now);
  return week === null ? null : weekDecision({ ...week, now, ceiling: repo.autonomySlots, ...seen });
}

/**
 * The pace sentence and the efficiency beside it for the first autonomous
 * repository with a crew, as the idle reason picks it; null while no account's
 * week has a known cap. Home and the terminal's dashboard print the same words.
 */
export function weekWords(app: App, now: Date = new Date()): string | null {
  for (const repo of listAutonomousRepos(app.db)) {
    if (repo.autonomy !== "autonomous" || repo.archivedAt !== null) continue;
    const week = weekFor(app, repo, now);
    if (week !== null) return `${week.sentence} ${efficiencyWords(weekEfficiency(app, repo, now))}`;
  }
  return null;
}
