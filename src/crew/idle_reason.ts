/**
 * Why the builders are idle, as one word and a link (#7663): plain data for
 * the terminal's dashboard (and a later tile) to print.
 *
 * Every reason is asked of the module the dispatcher asks it of, in the
 * dispatcher's order, and the first that holds is the answer: the day's
 * ceiling (`atCeiling` against `spentToday`, as `queueAgentRun` asks it), then
 * what `heldNow` sorts (`held.ts`: `nothing
 * ready` is its empty `startable`), and the subscriptions' headroom (`pace`,
 * as `repoPace` asks it). The repository is the first autonomous one with a
 * crew and someone to act as, which is what the loop drives.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { listAutonomousRepos } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { standings } from "../core/standing.ts";
import { grantedAccounts } from "../core/subscriptions.ts";
import { slottedRuns, spentToday } from "./autonomy.ts";
import { atCeiling } from "./dispatch.ts";
import { heldNow, HOLDS } from "./held.ts";
import { pace } from "./pacing.ts";

export interface IdleReason {
  readonly word: string;
  readonly href: string;
}

/** Why no builder is starting anything now; null while a builder slot is busy or something can start. */
export function idleReason(app: App, now: Date): IdleReason | null {
  const { db } = app;
  for (const repo of listAutonomousRepos(db)) {
    if (repo.autonomy !== "autonomous" || repo.autonomyBy === null || repo.archivedAt !== null) continue;
    const crew = listCrewRoles(db, repo.id);
    if (crew.length === 0) continue;

    // Slots are the builders' work in progress: the very runs the loop counts.
    const active = listActive(db, "agent").filter((r) => r.repoId === repo.id);
    if (slottedRuns(active, crew).length >= repo.autonomySlots) return null;

    if (atCeiling(repo, spentToday(db, repo.id, now))) return { word: "ceiling reached", href: "/meter" };

    const granted = grantedAccounts(db, repo.id, repo.ownerId);
    if (granted.length > 0) {
      const stand = standings(db, granted.map((a) => a.id), now);
      const accounts = granted.flatMap((a) => {
        const s = stand.get(a.id);
        return s === undefined ? [] : [{ name: a.name, standing: s }];
      });
      // Whether a window has room does not depend on what a run costs.
      if (pace(accounts, repo.autonomySlots, 1, now).slots === 0)
        return { word: "no subscription with headroom", href: "/subscriptions" };
    }

    const held = heldNow(app, repo);
    if (held.startable.length > 0) return null;
    // "Nothing ready" is true only when the map's ready list is empty; otherwise the ready issues are all held.
    const ready = HOLDS.reduce((n, h) => n + held.by[h].length, 0);
    return { word: ready === 0 ? "nothing ready" : "none startable", href: "/map" };
  }
  return null;
}

/** The reason as one line, the same words wherever it is printed. */
export function idleLine(reason: IdleReason): string {
  return `Builders idle: ${reason.word} (${reason.href})`;
}
