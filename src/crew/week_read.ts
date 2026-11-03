/**
 * The week's figures for a repository, read from the standing and the
 * ledger and handed to the pure policy in `week.ts` (#8695).
 */

import type { App } from "../app.ts";
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { measureFor } from "../core/measure.ts";
import { getHeadroom, WINDOW_MS } from "../core/standing.ts";
import { grantedAccounts, PLATFORM } from "../core/subscriptions.ts";
import { burnFrom, noteReading, readingsSince } from "./week_burn.ts";
import { capacityCount, paceFloor } from "../core/capacity.ts";
import { efficiencyWords, WEEK, weekDecision, type Efficiency, type WeekDecision, type WeekMeter } from "./week.ts";

/** The week as the provider's meter reads it: a meter, or null while no account's limit is known. */
interface Week {
  readonly meter: WeekMeter | null;
  /** The accounts the meter reads, as one key: repositories drawing on the same accounts share one week. */
  readonly scope: string;
}

/** How long a repository's week is remembered: `repoPace` is asked many times a tick. */
const REMEMBER_MS = 5_000;
const remembered = new Map<string, { at: number; week: Week }>();

/** Forget what was remembered, so the next ask reads again. */
export function forgetWeek(): void {
  remembered.clear();
}

/** The week's meter over the repository's accounts; an unknown meter while none has a known limit. */
function weekOf(app: App, repo: Repo, now: Date): Week {
  const key = `${app.config.dataDir}\0${repo.id}`;
  const hit = remembered.get(key);
  if (hit !== undefined && Math.abs(now.getTime() - hit.at) < REMEMBER_MS) return hit.week;
  const week = readWeek(app, repo, now);
  remembered.set(key, { at: now.getTime(), week });
  return week;
}

function readWeek(app: App, repo: Repo, now: Date): Week {
  // A crew with no grant runs on the forge's own token: the account `usage`
  // prints as `platform`. It is metered too, never skipped (#8873).
  const granted = grantedAccounts(app.db, repo.id, repo.ownerId).map((a) => a.id);
  const accounts = granted.length > 0 ? granted : [PLATFORM];
  // The provider's own percent of the week used (#8960), never dollars: an
  // account it has not measured, or whose week has reset since, is unknown.
  let usedPct = 0;
  let keptPct = 0;
  let resetsAt: number | null = null;
  const known: string[] = [];
  for (const id of accounts) {
    const m = measureFor(app.db, id, "week", now);
    if (m === null) continue;
    known.push(id);
    usedPct += m.usedPct;
    keptPct += getHeadroom(app.db, id) ?? 0;
    const at = Date.parse(m.resetsAt);
    if (resetsAt === null || at < resetsAt) resetsAt = at;
  }
  // No measurement is an unknown week, which holds the crew; it is never "not metered".
  if (resetsAt === null) return { meter: null, scope: [...accounts].sort().join(",") };
  const freePct = 100 - usedPct / known.length;
  // The burn is how fast the measured percent fell between successive readings of it.
  const scope = [...known].sort().join(",");
  const opened = resetsAt - WINDOW_MS.week;
  noteReading(app.db, scope, now.getTime(), freePct, WINDOW_MS.week);
  const readings = readingsSince(app.db, scope, opened);
  return {
    scope,
    meter: {
      freePct,
      keptPct: keptPct / known.length,
      burnPctPerHour: burnFrom(readings, now.getTime(), WEEK.burnHours),
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
  const since = week.meter === null ? now.getTime() - WINDOW_MS.week : week.meter.resetsAt.getTime() - WINDOW_MS.week;
  return efficiencySince(app, repo, new Date(since));
}

/**
 * The week's decision for a repository, given the builders' idle slots and
 * the issues a builder may start and the Later gate alone holds. An unknown
 * week (no measure) is a decision that holds the crew; null only when the
 * measured reset is past or more than a week away, where no pace applies.
 */
export function weekFor(
  app: App,
  repo: Repo,
  now: Date,
  seen: { idleSlots: number; startable: number; gated: number } = { idleSlots: 0, startable: 0, gated: 0 },
): WeekDecision | null {
  const week = weekOf(app, repo, now);
  return weekDecision({ ...week, now, ceiling: repo.autonomySlots, floorSlots: paceFloor(app.db), ...seen });
}

/** The key of the accounts a repository draws its week from. */
export function weekScope(app: App, repo: Repo, now: Date): string {
  return weekOf(app, repo, now).scope;
}

/** The slots the whole crew may run at once: what `crew.concurrency` says, else the repository's own. */
export function crewCeiling(app: App, repo: Repo): number {
  return capacityCount(app.db, "crew.concurrency", repo.autonomySlots);
}

/**
 * The week's decision for the whole crew drawing on this repository's
 * accounts: one budget in slots across every repository, its ceiling the
 * crew's (`crew.concurrency`), its floor the crew's too (#8989).
 */
export function crewWeekFor(app: App, repo: Repo, now: Date): WeekDecision | null {
  const week = weekOf(app, repo, now);
  return weekDecision({ ...week, now, ceiling: crewCeiling(app, repo), floorSlots: paceFloor(app.db), idleSlots: 0, startable: 0, gated: 0 });
}

/**
 * The pace sentence and the efficiency beside it for the autonomous
 * repository the crew works most this week (the most agent runs; the first by
 * name on a tie), not whichever sorts first: a quiet repository's "nothing
 * landed" is not the forge's. With no measurement it says the pace is unknown; null only when no autonomous repository has a pace to state (a reset past or over a week off). Home and the
 * terminal's dashboard print the same words.
 */
export function weekWords(app: App, now: Date = new Date()): string | null {
  let best: { words: string; runs: number } | null = null;
  for (const repo of listAutonomousRepos(app.db)) {
    if (repo.autonomy !== "autonomous" || repo.archivedAt !== null) continue;
    const week = crewWeekFor(app, repo, now);
    if (week === null) continue;
    const efficiency = weekEfficiency(app, repo, now);
    if (best === null || efficiency.runs > best.runs) best = { words: `${week.sentence} The week allows the whole crew ${week.slots} of ${crewCeiling(app, repo)} slots across every repository. ${efficiencyWords(efficiency)}`, runs: efficiency.runs };
  }
  return best?.words ?? null;
}
