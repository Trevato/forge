/**
 * The week's figures for a repository, read from the standing and the
 * ledger and handed to the pure policy in `week.ts` (#8695).
 */

import type { App } from "../app.ts";
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { standings, WINDOW_MS } from "../core/standing.ts";
import { grantedAccounts, PLATFORM } from "../core/subscriptions.ts";
import { efficiencyWords, WEEK, weekDecision, type Efficiency, type WeekDecision, type WeekMeter } from "./week.ts";

/** The week as the provider's meter reads it: a meter, or null while no account's limit is known. */
interface Week {
  readonly meter: WeekMeter | null;
}

/** How long a repository's week is remembered: `repoPace` is asked many times a tick. */
const REMEMBER_MS = 5_000;
const remembered = new Map<string, { at: number; week: Week | null }>();

/** Forget what was remembered, so the next ask reads again. */
export function forgetWeek(): void {
  remembered.clear();
}

/** The week's meter over the repository's accounts; an unknown meter while none has a known limit. */
function weekOf(app: App, repo: Repo, now: Date): Week | null {
  const key = `${app.config.dataDir}\0${repo.id}`;
  const hit = remembered.get(key);
  if (hit !== undefined && Math.abs(now.getTime() - hit.at) < REMEMBER_MS) return hit.week;
  const week = readWeek(app, repo, now);
  remembered.set(key, { at: now.getTime(), week });
  return week;
}

/** Spend over the last `WEEK.burnHours`, in US dollars, on `ids`. */
function recentUsd(app: App, ids: readonly string[], now: Date): number {
  if (ids.length === 0) return 0;
  const since = new Date(now.getTime() - WEEK.burnHours * 3_600_000).toISOString();
  const marks = ids.map((_, i) => `?${i + 2}`).join(",");
  return (
    app.db
      .query<{ usd: number | null }, string[]>(
        `SELECT SUM(cost_usd) AS usd FROM usage WHERE at >= ?1 AND at <= ?${ids.length + 2} AND subscription_id IN (${marks})`,
      )
      .get(since, ...ids, now.toISOString())?.usd ?? 0
  );
}

function readWeek(app: App, repo: Repo, now: Date): Week | null {
  // A crew with no grant runs on the forge's own token: the account `usage`
  // prints as `platform`. It is metered too, never skipped (#8873).
  const granted = grantedAccounts(app.db, repo.id, repo.ownerId).map((a) => a.id);
  const stand = standings(app.db, granted.length > 0 ? granted : [PLATFORM], now);
  let capUsd = 0;
  let freeUsd = 0;
  let keptUsd = 0;
  let resetsAt: number | null = null;
  const known: string[] = [];
  for (const [id, s] of stand) {
    const w = s.windows.find((x) => x.window === "week");
    if (w === undefined || w.cap === null || w.kept === null || w.remaining === null || w.resetsAt === null) continue;
    known.push(id);
    capUsd += w.cap.value;
    freeUsd += w.remaining.value;
    keptUsd += w.kept.value;
    const at = Date.parse(w.resetsAt.value);
    if (resetsAt === null || at < resetsAt) resetsAt = at;
  }
  if (resetsAt === null || !(capUsd > 0)) {
    // Granted accounts with no known limit are an unknown week; the forge's own token with none is not metered at all.
    return granted.length > 0 ? { meter: null } : null;
  }
  return {
    meter: {
      freePct: (freeUsd / capUsd) * 100,
      keptPct: (keptUsd / capUsd) * 100,
      burnPctPerHour: ((recentUsd(app, known, now) / capUsd) * 100) / WEEK.burnHours,
      resetsAt: new Date(resetsAt),
    },
  };
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
  const since = week?.meter == null ? now.getTime() - WINDOW_MS.week : week.meter.resetsAt.getTime() - WINDOW_MS.week;
  return efficiencySince(app, repo, new Date(since));
}

/**
 * The week's decision for a repository, given the builders' idle slots and
 * the issues a builder may start and the Later gate alone holds; null while
 * no account is metered.
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
 * repository with a crew, as the idle reason picks it; null while no account
 * is metered. Home and the terminal's dashboard print the same words.
 */
export function weekWords(app: App, now: Date = new Date()): string | null {
  for (const repo of listAutonomousRepos(app.db)) {
    if (repo.autonomy !== "autonomous" || repo.archivedAt !== null) continue;
    const week = weekFor(app, repo, now);
    if (week !== null) return `${week.sentence} ${efficiencyWords(weekEfficiency(app, repo, now))}`;
  }
  return null;
}
