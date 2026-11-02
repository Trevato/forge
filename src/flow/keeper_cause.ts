/**
 * What binds the forge's landings right now (#7645): one cause from a closed
 * list, in the order the dispatcher meets them. `pickCause` is plain data in,
 * plain data out; `readKeeperFacts` reads the same questions the dispatcher
 * asks (`heldNow`, `atCeiling`, `pace`) so the keeper and the builders cannot
 * disagree. No model is asked anything.
 */

import type { App } from "../app.ts";
import { listCrewRoles } from "../core/agents.ts";
import { listAutonomousRepos } from "../core/repos.ts";
import { listActive } from "../core/runs.ts";
import { standings } from "../core/standing.ts";
import { grantedAccounts } from "../core/subscriptions.ts";
import { slottedRuns, spentToday } from "../crew/autonomy.ts";
import { atCeiling } from "../crew/dispatch.ts";
import { heldNow } from "../crew/held.ts";
import { pace } from "../crew/pacing.ts";
import { readPile } from "./pile.ts";
import { readStaleReds } from "./stale_reds.ts";

export const KEEPER_CAUSES = [
  "ceiling",
  "usage",
  "unassigned",
  "empty_pillar",
  "stale_reds",
  "red_checks",
  "stale_pile",
  "capacity",
] as const;

export type KeeperCause = (typeof KEEPER_CAUSES)[number];

/** What the keeper does about a cause: unstick, file once, or only say. */
export type KeeperMove = "unstick" | "file" | "say";

export interface RepoFacts {
  readonly repoId: string;
  readonly slug: string;
  /** Ready issues a builder could start now. */
  readonly startable: number;
  /** Builder runs in flight, and the slots they fill. */
  readonly running: number;
  readonly slots: number;
  readonly ceilingUsd: number;
  readonly atCeiling: boolean;
  readonly noHeadroom: boolean;
  /** When the soonest spent window resets (ISO), if a subscription is out. */
  readonly resetsAt: string | null;
}

export interface KeeperFacts {
  readonly repos: readonly RepoFacts[];
  readonly red: number;
  /** Red pulls with no run for 30 min and no person holding them. */
  readonly staleReds?: number;
  readonly stale: number;
}

export interface Found {
  readonly cause: KeeperCause;
  readonly move: KeeperMove;
  /** One sentence naming it. */
  readonly says: string;
  readonly repoId: string;
}

/** The pile that is not moving counts as stale from this many pulls; red from this many. */
export const STALE_PULLS = 20;
export const RED_PULLS = 5;
export const STALE_REDS = 3;

const hhmm = (iso: string): string => `${iso.slice(11, 16)} UTC`;

/** The first cause that binds, skipping those already tried; null when none does. */
export function pickCause(f: KeeperFacts, skip: ReadonlySet<KeeperCause> = new Set()): Found | null {
  const hit = (found: Found): Found | null => (skip.has(found.cause) ? null : found);
  for (const r of f.repos) {
    const waiting = r.startable;
    if (r.atCeiling && waiting > 0 && !skip.has("ceiling"))
      return { cause: "ceiling", move: "say", repoId: r.repoId, says: `The daily ceiling ($${r.ceilingUsd}) is reached in ${r.slug}: builders start again at 00:00 UTC.` };
  }
  for (const r of f.repos) {
    if (r.noHeadroom && r.startable > 0 && !skip.has("usage"))
      return {
        cause: "usage",
        move: "say",
        repoId: r.repoId,
        says: `Usage is the limit: no subscription has headroom${r.resetsAt ? `, resets at ${hhmm(r.resetsAt)}` : ""}.`,
      };
  }
  for (const r of f.repos) {
    if (r.startable > 0 && r.running === 0 && !r.atCeiling && !r.noHeadroom) {
      const found = hit({
        cause: "unassigned",
        move: "unstick",
        repoId: r.repoId,
        says: `${r.startable} ready issue${r.startable === 1 ? "" : "s"} in ${r.slug} and no builder is running.`,
      });
      if (found) return found;
    }
  }
  const first = f.repos[0];
  if (first && f.repos.every((r) => r.startable === 0)) {
    const found = hit({ cause: "empty_pillar", move: "file", repoId: first.repoId, says: "Nothing is ready: no pillar has an issue a builder can start." });
    if (found) return found;
  }
  if (first && (f.staleReds ?? 0) >= STALE_REDS) {
    const found = hit({ cause: "stale_reds", move: "say", repoId: first.repoId, says: `${f.staleReds} open crew pulls are red and no run is working them: the sweep reworks, parks or closes them a few a tick.` });
    if (found) return found;
  }
  if (first && f.red >= RED_PULLS) {
    const found = hit({ cause: "red_checks", move: "file", repoId: first.repoId, says: `${f.red} open crew pulls have a red check.` });
    if (found) return found;
  }
  if (first && f.stale >= STALE_PULLS) {
    const found = hit({ cause: "stale_pile", move: "file", repoId: first.repoId, says: `${f.stale} open crew pulls are waiting on a builder or a reviewer.` });
    if (found) return found;
  }
  for (const r of f.repos) {
    if (r.running >= r.slots && r.slots > 0 && !skip.has("capacity"))
      return { cause: "capacity", move: "say", repoId: r.repoId, says: `All ${r.slots} builder slot${r.slots === 1 ? "" : "s"} in ${r.slug} are busy.` };
  }
  return null;
}

/** The facts, read from the dispatcher's own questions. */
export function readKeeperFacts(app: App, now: Date): KeeperFacts {
  const { db } = app;
  const repos: RepoFacts[] = [];
  for (const repo of listAutonomousRepos(db)) {
    if (repo.autonomy !== "autonomous" || repo.autonomyBy === null || repo.archivedAt !== null) continue;
    const crew = listCrewRoles(db, repo.id);
    if (crew.length === 0) continue;
    const held = heldNow(app, repo);
    const active = listActive(db, "agent").filter((r) => r.repoId === repo.id);
    let noHeadroom = false;
    let resetsAt: string | null = null;
    const granted = grantedAccounts(db, repo.id, repo.ownerId);
    if (granted.length > 0) {
      const stand = standings(db, granted.map((a) => a.id), now);
      const accounts = granted.flatMap((a) => {
        const s = stand.get(a.id);
        return s === undefined ? [] : [{ name: a.name, standing: s }];
      });
      noHeadroom = pace(accounts, repo.autonomySlots, 1, now).slots === 0;
      if (noHeadroom)
        for (const a of accounts)
          for (const w of a.standing.windows)
            if (w.resetsAt && (resetsAt === null || w.resetsAt.value < resetsAt)) resetsAt = w.resetsAt.value;
    }
    repos.push({
      repoId: repo.id,
      slug: `${repo.ownerName}/${repo.name}`,
      startable: held.startable.length,
      running: slottedRuns(active, crew).length,
      slots: repo.autonomySlots,
      ceilingUsd: repo.autonomyCeilingUsd,
      atCeiling: atCeiling(repo, spentToday(db, repo.id, now)),
      noHeadroom,
      resetsAt,
    });
  }
  const pile = readPile(db);
  return { repos, red: pile.red, staleReds: readStaleReds(db, now).count, stale: pile.awaitingReview + pile.changesAsked + pile.approved };
}
