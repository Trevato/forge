/**
 * The week's figures for a repository, read from the standing and the
 * ledger and handed to the pure policy in `week.ts` (#8695).
 */

import type { App } from "../app.ts";
import { listAutonomousRepos, type Repo } from "../core/repos.ts";
import { measureFor } from "../core/measure.ts";
import { getHeadroom, WINDOW_MS } from "../core/standing.ts";
import { grantedAccounts, PLATFORM } from "../core/subscriptions.ts";
import { belowCeiling, capacityCount, capacityValue, weekUse } from "../core/capacity.ts";
import { efficiencyWords, weekDecision, type Efficiency, type WeekDecision, type WeekMeter } from "./week.ts";

/** The week as the provider's meter reads it: a meter, or null while no account's limit is known. */
interface Week {
  readonly meter: WeekMeter | null;
}

/** How long a repository's week is remembered: `weekFor` is asked many times a tick. */
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
  // No measurement is an unmeasured week: nothing holds the crew but the provider.
  if (resetsAt === null) return { meter: null };
  return { meter: { freePct: 100 - usedPct / known.length, keptPct: keptPct / known.length, resetsAt: new Date(resetsAt) } };
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

/** The week's decision for a repository; null while the week is unmeasured. */
export function weekFor(app: App, repo: Repo, now: Date): WeekDecision | null {
  return weekDecision({ meter: weekOf(app, repo, now).meter, now, ceiling: repo.autonomySlots, reserve: 1 - weekUse(app.db) / 100 });
}

/**
 * The slots the whole crew may run at once: what `crew.concurrency` says, else
 * the default the crew booted with — the same number the pump starts runs
 * under (`dispatch.ts`), so home never says 5 of 5 while the crew runs 4
 * (#10440) — else the repository's own.
 */
export function crewCeiling(app: App, repo: Repo): number {
  const booted = Number(capacityValue(app.db, "crew.concurrency"));
  return capacityCount(app.db, "crew.concurrency", Number.isInteger(booted) && booted > 0 ? booted : repo.autonomySlots);
}

/** The week's decision for the whole crew drawing on this repository's accounts, at the crew's ceiling. */
export function crewWeekFor(app: App, repo: Repo, now: Date): WeekDecision | null {
  return weekDecision({ meter: weekOf(app, repo, now).meter, now, ceiling: crewCeiling(app, repo), reserve: 1 - weekUse(app.db) / 100 });
}

/** A sentence saying the crew's cap is lowered, so pacing is not mistaken for it; empty at the ceiling. */
function heldWords(app: App): string {
  const held = belowCeiling(app.db, "crew.concurrency");
  return held === null ? "" : ` Crew concurrency is set to ${held.value}, below its ceiling of ${held.ceiling}: that cap holds the crew back, not the week. Settings → Usage → Capacity puts it back.`;
}

/**
 * The autonomous repository the crew works most this week (the most agent
 * runs; the first by name on a tie) among those with a measured week, and
 * what `read` makes of it. The one pick `weekWords` and `budgetEffect` share.
 */
function busiest<T>(app: App, now: Date, read: (repo: Repo, week: WeekDecision) => T | null): T | null {
  let best: { value: T; runs: number } | null = null;
  for (const repo of listAutonomousRepos(app.db)) {
    if (repo.autonomy !== "autonomous" || repo.archivedAt !== null) continue;
    const week = crewWeekFor(app, repo, now);
    if (week === null) continue;
    const value = read(repo, week);
    if (value === null) continue;
    const runs = weekEfficiency(app, repo, now).runs;
    if (best === null || runs > best.runs) best = { value, runs };
  }
  return best?.value ?? null;
}

/**
 * The week sentence and the efficiency beside it for the busiest autonomous
 * repository (`busiest`), not whichever sorts first: a quiet repository's "nothing
 * landed" is not the forge's. Null when no autonomous repository has a measured week. Home and the
 * terminal's dashboard print the same words.
 */
export function weekWords(app: App, now: Date = new Date()): string | null {
  return busiest(app, now, (repo, week) => `${week.sentence} ${efficiencyWords(weekEfficiency(app, repo, now))}${heldWords(app)}`);
}

/** The owner's week on Home and the terminal. */
export function weekBlock(app: App, now: Date = new Date()): string[] {
  const words = weekWords(app, now);
  return words === null ? [] : [words];
}

/** The weekly-budget knob's live effect (#10461): `25% of the week used, the crew may use up to 90%`. Plain words while the week is unmeasured. */
export function budgetEffect(app: App, now: Date = new Date()): string {
  return busiest(app, now, (_repo, week) => week.sentence.replace(/\.$/, "")) ?? "the week is not measured yet; nothing holds the crew but the provider";
}

/** The week as two numbers for a meter: the share used and the most the crew may use, for the busiest autonomous repository; null while no week is measured. */
export function weekShare(app: App, now: Date = new Date()): { readonly usedPct: number; readonly mayUsePct: number } | null {
  return busiest(app, now, (_repo, week) => ({ usedPct: week.usedPct, mayUsePct: week.mayUsePct }));
}
